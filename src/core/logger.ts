/**
 * Structured logging wrapper. Logs to stderr and the user-level log file.
 */

import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Severity order for the `OPENCODE_DEV_FRAMEWORK_LOG_LEVEL` gate below. */
const LOG_SEVERITIES: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Minimum level that reaches stderr/file, from
 * `OPENCODE_DEV_FRAMEWORK_LOG_LEVEL` (default `debug` = current behavior:
 * everything is emitted). Unknown values fall back to `debug`.
 * Defense-in-depth so one chatty future call site cannot spam the log —
 * today every site is disciplined, so the default changes nothing.
 */
function resolveMinLevel(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const raw = env.OPENCODE_DEV_FRAMEWORK_LOG_LEVEL?.toLowerCase();
  return raw === "info" || raw === "warn" || raw === "error" ? raw : "debug";
}

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

/**
 * Directories already created by `appendLogFile` this process: the log
 * path is fixed, so `mkdir -p` on every line is pure syscall overhead.
 * Best-effort like everything else here — a failed `mkdir` simply never
 * lands in the set and is retried next write.
 */
const createdDirs = new Set<string>();

/** Best-effort file write: creates the parent dir, rotates past the cap, never throws. */
async function appendLogFile(
  filePath: string,
  line: string,
  maxBytes: number = MAX_LOG_BYTES,
): Promise<void> {
  try {
    // The log path is fixed per process, so the parent dir only needs
    // creating once — not on every line.
    const dir = dirname(filePath);
    if (!createdDirs.has(dir)) {
      await mkdir(dir, { recursive: true });
      createdDirs.add(dir);
    }
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
 * Create a logger. Writes to stderr and the user-level log file.
 */
export function createLogger(): LogFn {
  // Explicit override wins (empty string disables file logging:
  // the falsy filePath below skips all writes); otherwise a
  // user-level default so the "loud" record exists without
  // configuration. Resolved once: the path cannot change under
  // a running server.
  const filePath =
    process.env.OPENCODE_DEV_FRAMEWORK_LOG_FILE ?? resolveDefaultLogFile() ?? undefined;
  const minLevel = resolveMinLevel();
  return async (level, message, extra) => {
    if (LOG_SEVERITIES[level] < LOG_SEVERITIES[minLevel]) return;
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      service: LOG_SERVICE,
      level,
      message,
      extra,
    });

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
