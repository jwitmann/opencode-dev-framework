/**
 * opencode-dev-framework plugin entry point.
 *
 * Wired so far:
 * - tool.execute.before -> protected-path / dangerous-command guardrails
 * - event (file.edited)  -> per-edit lint + changed-file tracking
 * - event (session.idle) -> completion gate fallback (advisory logging)
 * - experimental.chat.system.transform -> constitution injection + session mapping
 * - experimental.session.stopping -> blocking completion gate (OpenCode >= PR #41811)
 * - tool -> dev_framework_init / dev_framework_set_profile custom tools
 */

import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import { loadConfig } from "./config.js";
import {
  type ChangedFileTracker,
  createChangedFileTracker,
  runGate,
  summarizeGate,
} from "./gate.js";
import { runCommand, type RunCommand } from "./host.js";
import { isLintFailure, lintFile, summarizeLint } from "./lint.js";
import { createLogger, type LogFn } from "./logger.js";
import { checkToolCall } from "./protect.js";
import {
  getDirectoryForSession,
  getHookState,
  setHookState,
  setSessionDirectory,
} from "./registry.js";
import { injectConstitution, loadConstitution } from "./rules.js";
import { buildTools } from "./tools.js";
import type { ResolvedConfig } from "./types.js";

/**
 * The `experimental.session.stopping` hook was added in OpenCode PR #41811
 * and is not yet in the published `@opencode-ai/plugin` types. We define it
 * locally so the plugin compiles and automatically uses the hook when the
 * runtime supports it.
 */
export interface HooksWithStopping extends Hooks {
  "experimental.session.stopping"?: (
    input: { sessionID: string },
    output: { context: string[] },
  ) => Promise<void>;
}

/**
 * Build the plugin's hooks and custom tools. Exported (rather than inlined in
 * the plugin) so tests can inject a stubbed command runner and tracker.
 */
export function buildHooks(
  ctx: PluginInput,
  config: ResolvedConfig,
  log: LogFn,
  run: RunCommand = runCommand,
  tracker: ChangedFileTracker = createChangedFileTracker(),
  constitution: string | null = null,
): HooksWithStopping {
  const directory = ctx.directory;
  // Note: hooks still close over `directory` (unlike the registry state, which
  // exists because OpenCode's Effect runtime stripped closure captures of
  // config/log/run in production). This is deliberate: `directory` is only
  // used as an optional hint (cwd, path relativization), so if it were ever
  // stripped the hooks degrade gracefully instead of crashing.
  setHookState(directory, {
    config,
    log,
    run,
    tracker,
    constitution,
    blockCounts: new Map(),
  });

  return {
    tool: buildTools(ctx),

    "experimental.chat.system.transform": async (input, output) => {
      const state = getHookState();
      if (!state) {
        return;
      }
      if (input.sessionID) {
        setSessionDirectory(input.sessionID, directory);
      }
      const next = injectConstitution(output.system, state.constitution);
      if (next !== output.system) {
        await state.log("info", "constitution injected into system prompt");
        output.system = next;
      }
    },

    "tool.execute.before": async (input, output) => {
      const state = getHookState();
      if (!state) {
        return;
      }
      const result = checkToolCall(state.config, input.tool, output.args, directory);
      if (result.decision === "allow") {
        return;
      }
      const message = result.reason ?? "blocked by guardrails";
      const extra = {
        tool: input.tool,
        sessionID: input.sessionID,
        pattern: result.matchedPattern,
      };
      if (result.decision === "warn") {
        await state.log("warn", message, extra);
        return;
      }
      await state.log("error", message, extra);
      throw new Error(`[opencode-dev-framework] ${message}`);
    },

    "experimental.session.stopping": async (input, output) => {
      const state = getHookState(getDirectoryForSession(input.sessionID) ?? undefined);
      if (!state?.config.gate || state.config.profile === "off") {
        return;
      }

      const changedFiles = state.tracker.getChangedFiles();
      const report = await runGate(state.run, state.config, changedFiles, { cwd: directory });
      if (!report.ran || report.ok) {
        state.tracker.clearChangedFiles();
        state.blockCounts.delete(input.sessionID);
        return;
      }

      const maxBlocks = state.config.gate.max_blocks ?? 3;
      const blockCount = (state.blockCounts.get(input.sessionID) ?? 0) + 1;
      state.blockCounts.set(input.sessionID, blockCount);

      if (blockCount > maxBlocks) {
        // Standing down: clear the tracker so the session.idle fallback does
        // not re-run the same failing gate commands a second time.
        state.tracker.clearChangedFiles();
        await state.log(
          "warn",
          `completion gate has blocked ${maxBlocks} times; standing down but checks are still failing`,
          { failedSteps: report.failedSteps.map((step) => step.name) },
        );
        return;
      }

      const summary = summarizeGate(report);
      await state.log("error", summary, {
        failedSteps: report.failedSteps.map((step) => step.name),
      });

      output.context.push(
        `opencode-dev-framework completion gate blocked you from finishing (block ${blockCount}/${maxBlocks}). ` +
          `The following checks failed:\n\n${summary}\n\n` +
          `Fix the underlying cause and continue. Do NOT disable, skip, or weaken these checks to make them pass.`,
      );
    },

    event: async ({ event }) => {
      const state = getHookState();
      if (!state) {
        return;
      }
      if (event.type === "file.edited") {
        const filePath = event.properties.file;
        state.tracker.add(filePath, directory);
        if (!state.config.on_edit.lint) {
          return;
        }
        const outcome = await lintFile(state.run, state.config, filePath, {
          cwd: directory,
          timeout: state.config.gate?.timeout,
        });
        if (outcome.skipped) {
          await state.log("debug", summarizeLint(outcome), { filePath, reason: outcome.reason });
          return;
        }
        if (!isLintFailure(outcome)) {
          await state.log("info", summarizeLint(outcome), { filePath });
          return;
        }
        const summary = summarizeLint(outcome);
        await state.log("error", summary, {
          filePath,
          command: outcome.command?.join(" "),
          stdout: outcome.result?.stdout,
          stderr: outcome.result?.stderr,
        });
        // In strict mode lint failures throw. Note: file.edited is an event
        // notification (the edit already happened), so this cannot undo the
        // edit — it surfaces the failure loudly to the session.
        if (state.config.profile === "strict") {
          throw new Error(`[opencode-dev-framework] ${summary}`);
        }
        return;
      }
      if (event.type === "session.idle") {
        if (state.config.profile === "off") {
          return;
        }
        if (!state.config.gate) {
          await state.log(
            "warn",
            "plugin config is incomplete (missing gate section), skipping completion gate",
            { directory },
          );
          return;
        }
        const changedFiles = state.tracker.getChangedFiles();
        const report = await runGate(state.run, state.config, changedFiles, { cwd: directory });
        state.tracker.clearChangedFiles();
        const summary = summarizeGate(report);
        if (!report.ran) {
          await state.log("debug", summary);
          return;
        }
        if (report.ok) {
          await state.log("info", summary);
          return;
        }
        // The gate cannot physically block on session.idle (the turn already
        // ended), so failure visibility is the enforcement mechanism.
        const level = state.config.gate.block_on_failure ? "error" : "warn";
        await state.log(level, summary, {
          failedSteps: report.failedSteps.map((step) => ({
            name: step.name,
            command: step.command?.join(" "),
            exitCode: step.result?.exitCode,
            timedOut: step.result?.timedOut,
            stderr: step.result?.stderr,
          })),
        });
      }
    },
  };
}

export const devFramework: Plugin = async (ctx) => {
  const config = loadConfig(ctx.directory);

  // The off profile registers no hooks at all.
  if (config.profile === "off") {
    return {};
  }

  const log = createLogger(ctx.client);
  const { constitution, warning } = await loadConstitution(config, ctx.directory);
  if (warning) {
    await log("warn", warning);
  }

  return buildHooks(ctx, config, log, runCommand, createChangedFileTracker(), constitution);
};

export default devFramework;
