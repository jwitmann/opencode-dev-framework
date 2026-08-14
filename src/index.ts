import type { Plugin } from "@opencode-ai/plugin";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { checkToolCall } from "./protect.js";

/**
 * opencode-dev-framework plugin entry point.
 *
 * Wired so far:
 * - tool.execute.before -> protected-path / dangerous-command guardrails
 *
 * Coming in later phases:
 * - file.edited  -> per-edit lint (Phase 4, via the generic `event` hook)
 * - session.idle -> completion gate (Phase 5, via the generic `event` hook)
 * - session.created -> constitution injection (Phase 6)
 */
export const devFramework: Plugin = async (ctx) => {
  const config = loadConfig(ctx.directory);

  // The off profile registers no hooks at all.
  if (config.profile === "off") {
    return {};
  }

  const log = createLogger(ctx.client);

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
  };
};

export default devFramework;
