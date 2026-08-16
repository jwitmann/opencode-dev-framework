import type { ChangedFileTracker } from "./gate.js";
import type { RunCommand } from "./host.js";
import type { LogFn } from "./logger.js";
import type { ResolvedConfig } from "./types.js";

export interface HookState {
  config: ResolvedConfig;
  log: LogFn;
  run: RunCommand;
  tracker: ChangedFileTracker;
  constitution: string | null;
  /** Number of times the completion gate has blocked this session. */
  blockCount?: number;
}

/**
 * Per-directory hook state registry. OpenCode's effect runtime can strip
 * closure variables when invoking hooks asynchronously, so we store the state
 * in module-level maps and look it up at call time.
 */
const hookRegistry = new Map<string, HookState>();
let activeDirectory: string | null = null;

export function setHookState(directory: string, state: HookState): void {
  hookRegistry.set(directory, state);
  activeDirectory = directory;
}

export function getHookState(directoryHint?: string): HookState | null {
  const directory = directoryHint ?? activeDirectory;
  if (!directory) {
    return null;
  }
  return hookRegistry.get(directory) ?? null;
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

export function getActiveDirectory(): string | null {
  return activeDirectory;
}

export function setActiveDirectory(directory: string | null): void {
  activeDirectory = directory;
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
