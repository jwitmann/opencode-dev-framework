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
import { join } from "node:path";
import { clearConfigCache, loadConfig } from "./config.js";
import {
  type ChangedFileTracker,
  createChangedFileTracker,
  runGate,
  summarizeGate,
} from "./gate.js";
import { renderStatus } from "./format-status.js";
import { runCommand, type RunCommand } from "./host.js";
import { detectPreCommitAvailability, isLintFailure, lintFile, summarizeLint } from "./lint.js";
import { createLogger, type LogFn } from "./logger.js";
import { createMessenger, type SendMessageFn } from "./messenger.js";
import { checkToolCall } from "./protect.js";
import {
  clearSessionDirectory,
  getHookState,
  getStateForSession,
  setBaseDirectory,
  setHookState,
  setSessionDirectory,
  updateHookState,
  type HostPermission,
} from "./registry.js";
import { injectConstitution, loadConstitution } from "./rules.js";
import { setProfileInFile } from "./installer.js";
import { buildTools } from "./tools.js";
import type { Profile, ResolvedConfig } from "./types.js";

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
  sendMessage: SendMessageFn | null = createMessenger(ctx.client),
): HooksWithStopping {
  // All hook state — including the project directory — lives in the registry
  // and is looked up at call time. OpenCode's Effect runtime stripped closure
  // captures in production (config/log/run came back undefined), so hooks must
  // not rely on variables from this scope.
  setHookState(ctx.directory, {
    directory: ctx.directory,
    config,
    log,
    run,
    tracker,
    constitution,
    blockCounts: new Map(),
    sendMessage,
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

      if (!typedConfig.command) {
        typedConfig.command = {};
      }
      typedConfig.command["df-status"] = {
        template: "",
        description: "Show the current dev-framework state",
      };
      typedConfig.command["df-profile"] = {
        template: "",
        description: "Change the dev-framework profile (off, advisory, standard, strict)",
      };
      typedConfig.command["df-verify"] = {
        template: "",
        description: "Run the dev-framework completion gate manually",
      };
      typedConfig.command["df-help"] = {
        template: "",
        description: "List the available dev-framework slash commands",
      };
    },

    "command.execute.before": async (input, output) => {
      const state = getStateForSession(input.sessionID);
      if (!state) {
        const fallback = "[opencode-dev-framework] plugin state is not available for this session.";
        output.parts.length = 0;
        output.parts.push({ type: "text", text: fallback, ignored: true } as never);
        return;
      }

      const directory = state.directory;
      const reply = async (text: string) => {
        if (state.sendMessage) {
          output.parts.length = 0;
          await state.sendMessage(input.sessionID, text);
        } else {
          output.parts.length = 0;
          output.parts.push({ type: "text", text, ignored: true } as never);
        }
      };

      if (input.command === "df-help" || input.command === "df") {
        await reply(`df — opencode-dev-framework commands

/df-status    Show the current dev-framework state
/df-profile   Change the profile to off, advisory, standard, or strict
/df-verify    Run the completion gate manually
/df-help      Show this message`);
        await state.log("info", "df-help command executed", { directory });
        return;
      }

      if (input.command === "df-status") {
        await reply(renderStatus(state.config, state));
        await state.log("info", "df-status command executed", { directory });
        return;
      }

      if (input.command === "df-profile") {
        const profile = input.arguments.trim().toLowerCase();
        const validProfiles: Profile[] = ["off", "advisory", "standard", "strict"];
        if (!validProfiles.includes(profile as Profile)) {
          await reply(`Invalid profile "${profile}". Valid values: ${validProfiles.join(", ")}.`);
          return;
        }

        const configPath = join(state.directory, ".opencode-dev-framework.yml");
        await setProfileInFile(configPath, profile as Profile);
        clearConfigCache();
        const nextConfig = loadConfig(state.directory);
        const { constitution } = await loadConstitution(nextConfig, state.directory);
        updateHookState(state.directory, { config: nextConfig, constitution });

        await reply(
          `opencode-dev-framework profile set to "${profile}". Change applied immediately.`,
        );
        await state.log("info", "df-profile command executed", { directory, profile });
        return;
      }

      if (input.command === "df-verify") {
        const changedFiles = state.tracker.getChangedFiles();
        const report = await runGate(state.run, state.config, changedFiles, {
          cwd: state.directory,
        });
        const summary = summarizeGate(report);
        await reply(summary);
        const level = report.ok ? "info" : "error";
        await state.log(level, "df-verify command executed", {
          directory,
          ok: report.ok,
          ran: report.ran,
        });
        return;
      }

      // Unknown /df-* command — give a helpful response.
      if (input.command.startsWith("df-")) {
        await reply(`Unknown command /${input.command}. Try /df-help.`);
        await state.log("warn", "unknown df command", { directory, command: input.command });
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      const state = getStateForSession(input.sessionID);
      if (!state) {
        return;
      }
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
      if (!state?.config.gate || state.config.profile === "off") {
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

  return buildHooks(ctx, config, log, runCommand, createChangedFileTracker(), constitution);
};

export default devFramework;
