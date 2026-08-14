/**
 * opencode-dev-framework plugin entry point.
 *
 * Wired so far:
 * - tool.execute.before -> protected-path / dangerous-command guardrails
 * - event (file.edited)  -> per-edit lint
 *
 * Coming in later phases:
 * - session.idle    -> completion gate (Phase 5, via the generic `event` hook)
 * - session.created -> constitution injection (Phase 6)
 */

import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import { loadConfig } from "./config.js";
import { runCommand, type RunCommand } from "./host.js";
import { isLintFailure, lintFile, summarizeLint } from "./lint.js";
import { createLogger, type LogFn } from "./logger.js";
import { checkToolCall } from "./protect.js";
import type { ResolvedConfig } from "./types.js";

/**
 * Build the plugin's hooks. Exported (rather than inlined in the plugin) so
 * tests can inject a stubbed command runner.
 */
export function buildHooks(
  ctx: PluginInput,
  config: ResolvedConfig,
  log: LogFn,
  run: RunCommand = runCommand,
): Hooks {
  return {
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
      if (event.type !== "file.edited") {
        return;
      }
      if (!config.on_edit.lint) {
        return;
      }
      const filePath = event.properties.file;
      const outcome = await lintFile(run, config, filePath, {
        cwd: ctx.directory,
        timeout: config.gate.timeout,
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
    },
  };
}

export const devFramework: Plugin = async (ctx) => {
  const config = loadConfig(ctx.directory);

  // The off profile registers no hooks at all.
  if (config.profile === "off") {
    return {};
  }

  return buildHooks(ctx, config, createLogger(ctx.client));
};

export default devFramework;
