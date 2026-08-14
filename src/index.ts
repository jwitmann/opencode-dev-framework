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
  const onFileEdited = async (filePath: string): Promise<void> => {
    tracker.add(filePath, ctx.directory);
    if (!config?.on_edit?.lint) {
      return;
    }
    const outcome = await lintFile(run, config, filePath, {
      cwd: ctx.directory,
      timeout: config.gate?.timeout,
    });
    if (outcome.skipped) {
      await log("debug", summarizeLint(outcome), { filePath, reason: outcome.reason });
      return;
    }
    if (!isLintFailure(outcome)) {
      await log("info", summarizeLint(outcome), { filePath });
      return;
    }
    const summary = summarizeLint(outcome);
    await log("error", summary, {
      filePath,
      command: outcome.command?.join(" "),
      stdout: outcome.result?.stdout,
      stderr: outcome.result?.stderr,
    });
    // In strict mode lint failures throw. Note: file.edited is an event
    // notification (the edit already happened), so this cannot undo the
    // edit — it surfaces the failure loudly to the session.
    if (config.profile === "strict") {
      throw new Error(`[opencode-dev-framework] ${summary}`);
    }
  };

  const onSessionIdle = async (): Promise<void> => {
    if (!config?.gate) {
      await log(
        "warn",
        "plugin config is incomplete (missing gate section), skipping completion gate",
        {
          directory: ctx.directory,
          configType: typeof config,
        },
      );
      return;
    }
    const changedFiles = tracker.getChangedFiles();
    const report = await runGate(run, config, changedFiles, { cwd: ctx.directory });
    tracker.clearChangedFiles();
    const summary = summarizeGate(report);
    if (!report.ran) {
      await log("debug", summary);
      return;
    }
    if (report.ok) {
      await log("info", summary);
      return;
    }
    // The gate cannot physically block (session.idle fires after the turn
    // ends), so failure visibility is the enforcement mechanism.
    const level = config.gate.block_on_failure ? "error" : "warn";
    await log(level, summary, {
      failedSteps: report.failedSteps.map((step) => ({
        name: step.name,
        command: step.command?.join(" "),
        exitCode: step.result?.exitCode,
        timedOut: step.result?.timedOut,
        stderr: step.result?.stderr,
      })),
    });
  };

  return {
    "experimental.chat.system.transform": async (_input, output) => {
      const next = injectConstitution(output.system, constitution);
      if (next !== output.system) {
        await log("info", "constitution injected into system prompt");
        output.system = next;
      }
    },

    "tool.execute.before": async (input, output) => {
      const result = checkToolCall(config, input.tool, output.args, ctx.directory);
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
        await log("warn", message, extra);
        return;
      }
      await log("error", message, extra);
      throw new Error(`[opencode-dev-framework] ${message}`);
    },

    event: async ({ event }) => {
      if (event.type === "file.edited") {
        await onFileEdited(event.properties.file);
        return;
      }
      if (event.type === "session.idle") {
        await onSessionIdle();
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
