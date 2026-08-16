/**
 * opencode-dev-framework plugin entry point.
 *
 * Wired so far:
 * - tool.execute.before -> protected-path / dangerous-command guardrails
 * - event (file.edited)  -> per-edit lint + changed-file tracking
 * - event (session.idle) -> completion gate fallback (advisory logging)
 * - experimental.chat.system.transform -> constitution injection + session mapping
 * - experimental.session.stopping -> blocking completion gate (OpenCode >= PR #41811)
 * - config hook -> registers /df-status, /df-verify, /df-profile slash commands
 * - command.execute.before -> handles those slash commands directly
 */

import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { clearConfigCache, loadConfig } from "./config.js";
import {
  type ChangedFileTracker,
  createChangedFileTracker,
  runGate,
  summarizeGate,
} from "./gate.js";
import { runCommand, type RunCommand } from "./host.js";
import { detectPreCommitAvailability, isLintFailure, lintFile, summarizeLint } from "./lint.js";
import { createLogger, type LogFn } from "./logger.js";
import { checkToolCall } from "./protect.js";
import {
  clearSessionDirectory,
  getHookState,
  getStateForSession,
  setBaseDirectory,
  setHookState,
  setSessionDirectory,
  type HookState,
  type HostPermission,
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
 * Reload the in-memory config if the config file on disk changed since we last
 * loaded it. This makes out-of-process edits (e.g. a `/df-profile` change made
 * from the TUI module, which writes the file directly) take effect on the next
 * enforcement hook without restarting OpenCode.
 */
async function reloadConfigIfChanged(state: HookState): Promise<void> {
  const configPath = join(state.directory, ".opencode-dev-framework.yml");
  try {
    const stats = await stat(configPath);
    if (state.configMtime !== undefined && state.configMtime === stats.mtimeMs) {
      return;
    }
    clearConfigCache();
    const next = loadConfig(state.directory);
    const { constitution } = await loadConstitution(next, state.directory);
    state.config = next;
    state.constitution = constitution;
    state.configMtime = stats.mtimeMs;
  } catch {
    // Config file missing/unreadable — keep the current state.
  }
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
  configMtime?: number,
): HooksWithStopping {
  // All hook state — including the project directory — lives in the registry
  // and is looked up at call time. OpenCode's Effect runtime stripped closure
  // captures in production (config/log/run came back undefined), so hooks must
  // not rely on variables from this scope.
  const showToast: NonNullable<HookState["showToast"]> = (message, variant = "info") => {
    try {
      const tui = (
        ctx.client as unknown as {
          tui?: {
            showToast?: (input: {
              title?: string;
              message: string;
              variant?: string;
            }) => Promise<unknown>;
          };
        }
      ).tui;
      tui?.showToast?.({ title: "opencode-dev-framework", message, variant });
    } catch {
      // TUI may be unavailable; the log line is enough.
    }
  };
  setHookState(ctx.directory, {
    directory: ctx.directory,
    config,
    log,
    run,
    tracker,
    constitution,
    blockCounts: new Map(),
    showToast,
    configMtime,
  });

  return {
    tool: buildTools(ctx),

    config: async (opencodeConfig) => {
      const typedConfig = opencodeConfig as {
        permission?: HostPermission[];
        command?: Record<string, { template?: string; description?: string }>;
      };

      const state = getHookState(ctx.directory);
      if (state) {
        state.hostPermissions = typedConfig.permission ?? [];
      }

      // NOTE: `/df-profile` and `/df-verify` are intentionally NOT registered
      // here. Registering a command in the OpenCode config makes it a *prompt*
      // command, which feeds its argument to the model as a user turn. To keep
      // them out of the model context they are registered as TUI commands in
      // `tui.tsx` (keymap.registerLayer) instead.
    },

    "command.execute.before": async (input) => {
      // `/df-profile` and `/df-verify` are TUI commands (see tui.tsx), so they
      // never reach this server-side handler. This handler only exists to give
      // a helpful hint for mistyped `/df-*` commands that OpenCode still routes
      // here as prompt commands.
      if (!input.command.startsWith("df-")) {
        return;
      }
      const state = getStateForSession(input.sessionID);
      if (!state) {
        getHookState()?.showToast?.(
          "[opencode-dev-framework] plugin state is not available for this session.",
          "error",
        );
        return;
      }
      state.showToast?.(`Unknown command /${input.command}. Try /df-help.`, "warning");
      await state.log("warn", "unknown df command", {
        directory: state.directory,
        command: input.command,
      });
    },

    "experimental.chat.system.transform": async (input, output) => {
      const state = getStateForSession(input.sessionID);
      if (!state) {
        return;
      }
      await reloadConfigIfChanged(state);
      if (input.sessionID) {
        setSessionDirectory(input.sessionID, state.directory);
      }
      const next = injectConstitution(output.system, state.constitution);
      if (next !== output.system) {
        await state.log("info", "constitution injected into system prompt");
        output.system = next;
      }
    },

    "tool.execute.before": async (input, output) => {
      const state = getStateForSession(input.sessionID);
      if (!state) {
        throw new Error(
          "[opencode-dev-framework] plugin state is not available; guardrail cannot evaluate this tool call",
        );
      }
      await reloadConfigIfChanged(state);
      const result = checkToolCall(
        state.config,
        input.tool,
        output.args,
        state.directory,
        state.hostPermissions,
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

    "experimental.session.stopping": async (input, output) => {
      const state = getStateForSession(input.sessionID);
      if (!state) {
        return;
      }
      await reloadConfigIfChanged(state);
      if (!state.config.gate || state.config.profile === "off") {
        return;
      }

      const changedFiles = state.tracker.getChangedFiles();
      const report = await runGate(state.run, state.config, changedFiles, { cwd: state.directory });
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
      // session.deleted must run even without hook state so the session map
      // does not grow unboundedly.
      if (event.type === "session.deleted") {
        clearSessionDirectory(event.properties.info.id);
        return;
      }
      const sessionID =
        event.type === "session.idle"
          ? (event as unknown as { properties: { sessionID: string } }).properties.sessionID
          : undefined;
      const state = getStateForSession(sessionID);
      if (!state) {
        return;
      }
      await reloadConfigIfChanged(state);
      if (event.type === "file.edited") {
        const filePath = event.properties.file;
        state.tracker.add(filePath, state.directory);
        if (!state.config.on_edit.lint) {
          return;
        }
        if (state.config.precommit === "auto" && state.precommitAvailable === undefined) {
          state.precommitAvailable = await detectPreCommitAvailability(state.run, state.directory);
        }
        const outcome = await lintFile(state.run, state.config, filePath, {
          cwd: state.directory,
          timeout: state.config.gate?.timeout,
          precommitAvailable: state.precommitAvailable,
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
            { directory: state.directory },
          );
          return;
        }
        const changedFiles = state.tracker.getChangedFiles();
        const report = await runGate(state.run, state.config, changedFiles, {
          cwd: state.directory,
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
  const log = createLogger(ctx.client);

  let config: ResolvedConfig;
  try {
    config = loadConfig(ctx.directory);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await log("error", message, { directory: ctx.directory });
    const clientTui = (
      ctx.client as unknown as {
        tui?: { showToast?: (data: { type: string; message: string }) => Promise<unknown> };
      }
    ).tui;
    try {
      await clientTui?.showToast?.({
        type: "error",
        message: `[opencode-dev-framework] ${message}`,
      });
    } catch {
      // TUI may not be available; the log line is enough.
    }
    return {};
  }

  // The off profile registers no hooks at all.
  if (config.profile === "off") {
    return {};
  }

  setBaseDirectory(ctx.directory);

  const { constitution, warning } = await loadConstitution(config, ctx.directory);
  if (warning) {
    await log("warn", warning);
  }

  let configMtime: number | undefined;
  try {
    configMtime = (await stat(join(ctx.directory, ".opencode-dev-framework.yml"))).mtimeMs;
  } catch {
    // Config file may not exist yet; reloadConfigIfChanged will pick it up.
  }

  return buildHooks(
    ctx,
    config,
    log,
    runCommand,
    createChangedFileTracker(),
    constitution,
    configMtime,
  );
};

export default devFramework;
