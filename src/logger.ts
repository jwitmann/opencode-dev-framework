/**
 * Structured logging wrapper. Supports both V1 (client.app.log) and V2 (stderr/file).
 */

import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export const LOG_SERVICE = "opencode-dev-framework";

/** Leaf directory/file for the default user-level log. */
export const LOG_DIR_NAME = "opencode-dev-framework";
export const LOG_FILE_NAME = "opencode-dev-framework.log";

/**
 * Rotation cap: the active log never grows past this; one backup
 * (`*.1`) is kept, so worst case is 2× cap. 5MB holds thousands of
 * evaluations (lines are a few hundred bytes, summaries a few KB).
 */
export const MAX_LOG_BYTES = 5 * 1024 * 1024;

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

export interface LogPathInput {
  platform?: string;
  env?: Record<string, string | undefined>;
  home?: string | null;
  tmp?: string;
}

/**
 * Resolve the user-level default log file. Pure given explicit
 * inputs (production passes the real ones). `null` only when no
 * home directory is known AND tmp is unavailable — vanishingly
 * rare; callers treat null as file-logging-off (stderr remains).
 * Never inside the repo: a repo-local log would surface as an
 * untracked changed file and poison the tracker.
 */
export function resolveDefaultLogFile(input: LogPathInput = {}): string | null {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const home = input.home !== undefined ? input.home : safeHomedir();
  if (platform === "win32") {
    if (env.LOCALAPPDATA) {
      return join(env.LOCALAPPDATA, LOG_DIR_NAME, LOG_FILE_NAME);
    }
    // No LOCALAPPDATA: fall through to tmp, not a Unix-style home path.
    const winTmp = input.tmp ?? safeTmpdir();
    return winTmp ? join(winTmp, LOG_DIR_NAME, LOG_FILE_NAME) : null;
  }
  if (platform === "darwin" && home) {
    return join(home, "Library", "Logs", LOG_FILE_NAME);
  }
  if (home) {
    // Empty counts as unset and relative as invalid (XDG basedir spec);
    // either would otherwise land the log relative to CWD — possibly
    // inside the repo, where it would poison the change tracker.
    const xdg = env.XDG_DATA_HOME;
    const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "share");
    return join(base, LOG_DIR_NAME, LOG_FILE_NAME);
  }
  const tmp = input.tmp ?? safeTmpdir();
  return tmp ? join(tmp, LOG_DIR_NAME, LOG_FILE_NAME) : null;
}

function safeHomedir(): string | null {
  try {
    return homedir();
  } catch {
    return null;
  }
}

function safeTmpdir(): string | null {
  try {
    return tmpdir();
  } catch {
    return null;
  }
}

/** Best-effort file write: creates the parent dir, rotates past the cap, never throws. */
async function appendLogFile(
  filePath: string,
  line: string,
  maxBytes: number = MAX_LOG_BYTES,
): Promise<void> {
  try {
    await mkdir(dirname(filePath), { recursive: true });
    await rotateLogFile(filePath, maxBytes);
    await appendFile(filePath, `${line}\n`);
  } catch {
    // best-effort
  }
}

/**
 * Rotate the active log past the cap: the previous backup is
 * dropped, the active file becomes the backup, and appends start
 * fresh. Concurrent writers can interleave stat/rename and lose a
 * line — acceptable for a best-effort log, never for enforcement.
 */
export async function rotateLogFile(filePath: string, maxBytes: number): Promise<void> {
  let size = 0;
  try {
    size = (await stat(filePath)).size;
  } catch {
    return; // missing — nothing to rotate
  }
  if (size <= maxBytes) return;
  try {
    await rm(`${filePath}.1`, { force: true });
    await rename(filePath, `${filePath}.1`);
  } catch {
    // best-effort
  }
}

/**
 * Create a logger. If a V1 client is provided, forwards to `client.app.log`
 * (as tests expect). Otherwise logs to stderr/file (V2 runtime).
 */
export function createLogger(
  client?: V1Client | { app: { log: (...args: unknown[]) => Promise<unknown> } },
): LogFn {
  // Explicit override wins (empty string disables file logging:
  // the falsy filePath below skips all writes); otherwise a
  // user-level default so the "loud" record exists without
  // configuration. Resolved once: the path cannot change under
  // a running server.
  const filePath =
    process.env.OPENCODE_DEV_FRAMEWORK_LOG_FILE ?? resolveDefaultLogFile() ?? undefined;
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
        await appendLogFile(filePath, line);
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
      await appendLogFile(filePath, line);
    }
  };
}
