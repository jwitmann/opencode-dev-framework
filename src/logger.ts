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
 * Create a logger bound to the OpenCode client. Logging never throws:
 * `app.log` failures fall back to stderr so the failure stays visible
 * (a total swallow made production debugging painful during development),
 * and even stderr failures are ignored as a last resort.
 */
export function createLogger(client: PluginInput["client"]): LogFn {
  return async (level, message, extra) => {
    try {
      await client.app.log({ body: { service: LOG_SERVICE, level, message, extra } });
    } catch (error) {
      try {
        process.stderr.write(
          `[${LOG_SERVICE}] ${level} ${message} (app.log failed: ${String(error)})\n`,
        );
      } catch {
        // Even stderr may be unavailable; truly ignore.
      }
    }
  };
}
