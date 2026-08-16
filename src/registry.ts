import type { ChangedFileTracker } from "./gate.js";
import type { RunCommand } from "./host.js";
import type { LogFn } from "./logger.js";
import type { ResolvedConfig } from "./types.js";

export interface HostPermission {
  permission?: string;
  pattern?: string;
  action?: "allow" | "deny" | "ask";
}

export interface HookState {
  /** Project directory this state belongs to. Stored here (rather than
   * closure-captured by hooks) so every hook invocation is self-contained. */
  directory: string;
  config: ResolvedConfig;
  log: LogFn;
  run: RunCommand;
  tracker: ChangedFileTracker;
  constitution: string | null;
  /** Per-session count of completion-gate blocks (keyed by sessionID). */
  blockCounts: Map<string, number>;
  /** Cached result of checking whether `pre-commit` is available. */
  precommitAvailable?: boolean;
  /** Snapshot of host permissions from OpenCode's effective config. */
  hostPermissions?: HostPermission[];
  /** Show a non-chat TUI toast (used for slash-command results). */
  showToast?: (message: string, variant?: "info" | "success" | "warning" | "error") => void;
}

/**
 * Per-directory hook state registry. OpenCode's effect runtime can strip
 * closure variables when invoking hooks asynchronously, so we store the state
 * in module-level maps and look up values at call time.
 *
 * `baseDirectory` is the project root set at plugin initialization. Hooks that
 * receive only a session ID can fall back to this directory when the session
 * has not been mapped yet.
 */
const hookRegistry = new Map<string, HookState>();
let activeDirectory: string | null = null;
let baseDirectory: string | null = null;

export function setBaseDirectory(directory: string): void {
  baseDirectory = directory;
}

export function getBaseDirectory(): string | null {
  return baseDirectory;
}

export function setHookState(directory: string, state: HookState): void {
  hookRegistry.set(directory, state);
  activeDirectory = directory;
}

export function getHookState(directoryHint?: string): HookState | null {
  const directory = directoryHint ?? activeDirectory ?? baseDirectory;
  if (!directory) {
    return null;
  }
  return hookRegistry.get(directory) ?? null;
}

export function getStateForSession(sessionID: string | undefined): HookState | null {
  if (sessionID) {
    const mapped = getDirectoryForSession(sessionID);
    if (mapped) {
      return getHookState(mapped);
    }
  }
  return getHookState(baseDirectory ?? undefined);
}

export function updateHookState(directory: string, updates: Partial<HookState>): HookState | null {
  const state = hookRegistry.get(directory);
  if (!state) {
    return null;
  }
  const next = { ...state, ...updates };
  hookRegistry.set(directory, next);
  return next;
}

/** Map session IDs to their project directory so hooks that only receive a
 * session ID can still find their state. */
const sessionToDirectory = new Map<string, string>();

export function setSessionDirectory(sessionID: string, directory: string): void {
  sessionToDirectory.set(sessionID, directory);
}

export function getDirectoryForSession(sessionID: string): string | null {
  return sessionToDirectory.get(sessionID) ?? null;
}

/** Forget a session's directory mapping (called on `session.deleted`). */
export function clearSessionDirectory(sessionID: string): void {
  sessionToDirectory.delete(sessionID);
}
