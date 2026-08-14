/**
 * Structured logging wrapper around the OpenCode client's app.log API.
 */

import type { PluginInput } from "@opencode-ai/plugin";

export type LogLevel = "debug" | "info" | "warn" | "error";

export const LOG_SERVICE = "opencode-dev-framework";

export type LogFn = (
  level: LogLevel,
  message: string,
  extra?: Record<string, unknown>,
) => Promise<void>;

/**
 * Create a logger bound to the OpenCode client. Logging failures are
 * swallowed — logging must never break the plugin or a tool call.
 */
export function createLogger(client: PluginInput["client"]): LogFn {
  return async (level, message, extra) => {
    try {
      await client.app.log({ body: { service: LOG_SERVICE, level, message, extra } });
    } catch {
      // Intentionally ignored: logging is best-effort.
    }
  };
}
