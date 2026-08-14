/**
 * opencode-dev-framework plugin entry point.
 *
 * Wired so far:
 * - tool.execute.before -> protected-path / dangerous-command guardrails
 * - event (file.edited)  -> per-edit lint + changed-file tracking
 * - event (session.idle) -> completion gate (advisory: reports loudly, cannot block)
 * - experimental.chat.system.transform -> constitution injection
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
import { injectConstitution, loadConstitution } from "./rules.js";
import type { ResolvedConfig } from "./types.js";

interface HookState {
  config: ResolvedConfig;
  log: LogFn;
  run: RunCommand;
  tracker: ChangedFileTracker;
  constitution: string | null;
}

/**
 * Per-directory hook state registry. OpenCode's effect runtime can strip
 * closure variables when invoking hooks asynchronously, so we store the state
 * in module-level maps and look it up at call time.
 */
const hookRegistry = new Map<string, HookState>();
let activeDirectory: string | null = null;

function getHookState(directoryHint?: string): HookState | null {
  const directory = directoryHint ?? activeDirectory;
  if (!directory) {
    return null;
  }
  return hookRegistry.get(directory) ?? null;
}

/**
 * Build the plugin's hooks. Exported (rather than inlined in the plugin) so
 * tests can inject a stubbed command runner and tracker.
 */
export function buildHooks(
  ctx: PluginInput,
  config: ResolvedConfig,
  log: LogFn,
  run: RunCommand = runCommand,
  tracker: ChangedFileTracker = createChangedFileTracker(),
  constitution: string | null = null,
): Hooks {
  const directory = ctx.directory;
  hookRegistry.set(directory, { config, log, run, tracker, constitution });
  activeDirectory = directory;

  return {
    "experimental.chat.system.transform": async (_input, output) => {
      const state = getHookState();
      if (!state) {
        return;
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
      const result = checkToolCall(
        state.config,
        input.tool,
        output.args,
        activeDirectory ?? undefined,
      );
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

    event: async ({ event }) => {
      const state = getHookState();
      if (!state) {
        return;
      }
      if (event.type === "file.edited") {
        const filePath = event.properties.file;
        state.tracker.add(filePath, activeDirectory ?? undefined);
        if (!state.config.on_edit.lint) {
          return;
        }
        const outcome = await lintFile(state.run, state.config, filePath, {
          cwd: activeDirectory ?? undefined,
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
        if (!state.config.gate) {
          await state.log(
            "warn",
            "plugin config is incomplete (missing gate section), skipping completion gate",
            {
              directory: activeDirectory ?? undefined,
            },
          );
          return;
        }
        const changedFiles = state.tracker.getChangedFiles();
        const report = await runGate(state.run, state.config, changedFiles, {
          cwd: activeDirectory ?? undefined,
        });
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
        // The gate cannot physically block (session.idle fires after the turn
        // ends), so failure visibility is the enforcement mechanism.
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
