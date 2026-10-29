/**
 * Runtime status snapshot: the cross-process bridge between the server
 * plugin (which owns hook registration and gate dispatch state) and the
 * TUI plugin (which can only read the project directory).
 *
 * Written best-effort by the server after hook registration and on every
 * continuation dispatch; read by the TUI `/df-runtime` command. Never
 * throws: a missing, corrupt, or stale snapshot renders as
 * "not reported yet".
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Snapshot location, relative to the project directory. */
export const RUNTIME_STATUS_DIR = ".opencode/opencode-dev-framework";
export const RUNTIME_STATUS_FILE = "runtime-status.json";

/** Which session-hook key the core accepted, or neither. */
export type IdleHookVia = "experimental.idle" | "idle" | "none";

/** Dispatch history this session: hook-fired, net-fired, or neither yet. */
export type ContinuationState = "idle" | "fallback" | "armed";

export interface RuntimeStatus {
  frameworkVersion: string;
  idleHookVia: IdleHookVia;
  continuation: ContinuationState;
  updatedAt: string;
}

export function snapshotPath(directory: string): string {
  return join(directory, RUNTIME_STATUS_DIR, RUNTIME_STATUS_FILE);
}

/** Resolve the plugin version from the installed package.json. Works from
 * both `dist/` (production) and `src/` (vitest) layouts; "unknown" when
 * neither candidate parses. */
async function resolveFrameworkVersion(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "package.json"),
    join(here, "..", "..", "package.json"),
  ];
  for (const candidate of candidates) {
    try {
      const pkg = JSON.parse(await readFile(candidate, "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (pkg.name === "opencode-dev-framework" && typeof pkg.version === "string") {
        return pkg.version;
      }
    } catch {
      // try the next candidate
    }
  }
  return "unknown";
}

export async function writeRuntimeStatus(
  directory: string,
  partial: { idleHookVia: IdleHookVia; continuation: ContinuationState },
): Promise<void> {
  try {
    const status: RuntimeStatus = {
      frameworkVersion: await resolveFrameworkVersion(),
      ...partial,
      updatedAt: new Date().toISOString(),
    };
    await mkdir(join(directory, RUNTIME_STATUS_DIR), { recursive: true });
    await writeFile(snapshotPath(directory), `${JSON.stringify(status, null, 2)}\n`, "utf8");
  } catch {
    // Best-effort only: runtime reporting must never break the gate.
  }
}

function isIdleHookVia(value: unknown): value is IdleHookVia {
  return value === "experimental.idle" || value === "idle" || value === "none";
}

function isContinuationState(value: unknown): value is ContinuationState {
  return value === "idle" || value === "fallback" || value === "armed";
}

export async function readRuntimeStatus(directory: string): Promise<RuntimeStatus | null> {
  try {
    const parsed = JSON.parse(await readFile(snapshotPath(directory), "utf8")) as Partial<RuntimeStatus>;
    if (typeof parsed.frameworkVersion !== "string" || typeof parsed.updatedAt !== "string") {
      return null;
    }
    return {
      frameworkVersion: parsed.frameworkVersion,
      idleHookVia: isIdleHookVia(parsed.idleHookVia) ? parsed.idleHookVia : "none",
      continuation: isContinuationState(parsed.continuation) ? parsed.continuation : "armed",
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}
