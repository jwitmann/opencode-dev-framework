/**
 * Structured logging wrapper around the OpenCode client's app.log API.
 */

import { appendFile } from "node:fs/promises";
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
 *
 * If the `OPENCODE_DEV_FRAMEWORK_LOG_FILE` environment variable is set, every
 * log line is also appended to that path as JSON, which is useful when
 * `app.log` is unavailable or when a persistent trace is needed.
 */
export function createLogger(client: PluginInput["client"]): LogFn {
  const filePath = process.env.OPENCODE_DEV_FRAMEWORK_LOG_FILE;
  return async (level, message, extra) => {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      service: LOG_SERVICE,
      level,
      message,
      extra,
    });

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

    if (filePath) {
      try {
        await appendFile(filePath, `${line}\n`);
      } catch {
        // File logging is best-effort.
      }
    }
  };
}
