/**
 * Structured logging wrapper. Supports both V1 (client.app.log) and V2 (stderr/file).
 */

import { appendFile } from "node:fs/promises";

export type LogLevel = "debug" | "info" | "warn" | "error";

export const LOG_SERVICE = "opencode-dev-framework";

export type LogFn = (
  level: LogLevel,
  message: string,
  extra?: Record<string, unknown>,
) => Promise<void>;

// V1 client shape (subset) — kept for test compatibility
type V1Client = {
  app?: {
    log?: (args: {
      body: { service: string; level: LogLevel; message: string; extra?: Record<string, unknown> };
    }) => Promise<unknown>;
  };
};

/**
 * Create a logger. If a V1 client is provided, forwards to `client.app.log`
 * (as tests expect). Otherwise logs to stderr/file (V2 runtime).
 */
export function createLogger(
  client?: V1Client | { app: { log: (...args: unknown[]) => Promise<unknown> } },
): LogFn {
  const filePath = process.env.OPENCODE_DEV_FRAMEWORK_LOG_FILE;
  return async (level, message, extra) => {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      service: LOG_SERVICE,
      level,
      message,
      extra,
    });

    if (client?.app?.log) {
      try {
        // biome-ignore lint/style/noNonNullAssertion: guarded by if above
        await (client as V1Client).app!.log!({
          body: { service: LOG_SERVICE, level, message, extra },
        });
      } catch (error) {
        try {
          process.stderr.write(
            `[${LOG_SERVICE}] ${level} ${message} (app.log failed: ${String(error)})\n`,
          );
        } catch {
          // ignore
        }
      }
      if (filePath) {
        try {
          await appendFile(filePath, `${line}\n`);
        } catch {
          // best-effort
        }
      }
      return;
    }

    try {
      process.stderr.write(`[${LOG_SERVICE}] ${level} ${message}\n`);
      if (extra && Object.keys(extra).length > 0) {
        process.stderr.write(`  extra: ${JSON.stringify(extra)}\n`);
      }
    } catch {
      // ignore
    }

    if (filePath) {
      try {
        await appendFile(filePath, `${line}\n`);
      } catch {
        // best-effort
      }
    }
  };
}
