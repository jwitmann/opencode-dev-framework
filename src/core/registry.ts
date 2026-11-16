import type { ChangedFileTracker } from "./gate.js";
import type { RunCommand } from "./host.js";
import type { LogFn } from "./logger.js";
import type { ResolvedConfig } from "./types.js";

/**
 * OpenCode's native `permission` config is a per-agent, tool-to-mode object
 * (e.g. `{ edit: "deny", bash: "deny", read: "allow", task: {...} }`), not an
 * array. The plugin consults it only to avoid double-blocking: when OpenCode
 * already globally denies a tool, the guardrail stands down and lets OpenCode
 * enforce the denial. Path-scoped rules (e.g. "deny writes to .env") are not
 * expressible in OpenCode's permission model, so the plugin keeps guarding
 * those itself.
 */
export type OpenCodePermission = Record<string, unknown>;

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
  hostPermissions?: OpenCodePermission;
  /** Show a non-chat TUI toast (used for slash-command results). */
  showToast?: (message: string, variant?: "info" | "success" | "warning" | "error") => void;
  /** mtime (ms) of the config file at last load; used to detect out-of-process
   * edits (e.g. a `/df-profile` change made from the TUI module). */
  configMtime?: number;
  /** Which lever completed a gate evaluation most recently in this process:
   * `"idle"` once the `experimental.idle` hook has (same-execution
   * continuation active), `"fallback"` when only the `event.subscribe`
   * idle re-prompt net has. Absent until either fires. Memory-only: a
   * reload re-derives it on the next idle boundary. */
  continuationLevel?: "idle" | "fallback";
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

/**
 * Child-session resolution: one cached host walk per session lifetime.
 * `isChild` powers the plan-23 duty skip; `depth` is the plan-24 tripwire
 * (null = unknown). Resolved together so child-gated branches never pay
 * for the same lookup twice. Populated lazily and cleared with everything
 * else in `clearSessionDirectory`/`resetRegistry`. Memory-only like the
 * directory map.
 */
const childSessionCache = new Map<string, ChildSessionResolution>();

/** Structural parent link returned by the host session lookup. */
export interface SessionParentInfo {
  parentID?: string | null | undefined;
}

/** Outcome of one ancestry walk: duty verdict plus best-effort depth. */
export interface ChildSessionResolution {
  isChild: boolean;
  depth: number | null;
}

/**
 * Walk the `parentID` chain once, returning the duty verdict and the
 * depth together (depth 0 = top-level, null = unknown). Only a confirmed
 * not-found/deleted hop ends the walk as dead; any lookup failure
 * abandons it as unknown rather than guessing. Fails closed to
 * `{ isChild: false, depth: null }` (top-level): a missing getter (older
 * core), an empty sessionID, or a lookup throw preserves the pre-guard
 * behavior exactly. Results cache per sessionID, but only fully-resolved
 * walks: a throw or a nullish info (unknown to the host) returns
 * top-level WITHOUT caching, so one transient failure can never
 * permanently pin a session. Never throws. A pathological parent cycle
 * terminates via the visited set (the core API cannot currently produce
 * one: no `parentID` mutation, unknown parents rejected at creation).
 */
export async function resolveChildSession(
  sessionID: string,
  getSession?: (id: string) => Promise<SessionParentInfo | null | undefined>,
): Promise<ChildSessionResolution> {
  if (sessionID === "") return { isChild: false, depth: null };
  const cached = childSessionCache.get(sessionID);
  if (cached !== undefined) return cached;
  const fallback: ChildSessionResolution = { isChild: false, depth: null };
  if (getSession === undefined) return fallback;
  try {
    // An unknown first hop (nullish info) returns top-level WITHOUT
    // caching, so one transient failure can never permanently pin a
    // child as top-level (which would re-enable the original bug).
    const first = await getSession(sessionID);
    if (first === null || first === undefined) return fallback;
    const seen = new Set<string>([sessionID]);
    let current = sessionID;
    let parent = first.parentID;
    let depth = 0;
    let isChild = false;
    while (typeof parent === "string" && parent !== "" && !seen.has(parent)) {
      seen.add(parent);
      isChild = true;
      depth++;
      current = parent;
      try {
        parent = (await getSession(current))?.parentID;
      } catch {
        // Writer is live (first hop resolved) but deeper ancestry is
        // unknown: keep the duty verdict, abandon the depth, and do NOT
        // cache — the next call re-walks instead of pinning unknown.
        return { isChild: true, depth: null };
      }
    }
    // Fully-resolved walks cache (top-level `{false, 0}` too: parentage
    // is immutable and deletion evicts via `clearSessionDirectory`).
    const resolved: ChildSessionResolution = { isChild, depth };
    childSessionCache.set(sessionID, resolved);
    return resolved;
  } catch {
    return fallback;
  }
}

/**
 * True when the session is a child (subagent): it shares the
 * `resolveChildSession` cache, so pairing this with a depth read costs
 * nothing extra. Same fail-closed contract as the combined resolver.
 */
export async function resolveIsChildSession(
  sessionID: string,
  getSession?: (id: string) => Promise<SessionParentInfo | null | undefined>,
): Promise<boolean> {
  return (await resolveChildSession(sessionID, getSession)).isChild;
}

/**
 * Best-effort session-tree depth for the plan-24 tripwire: the number of
 * `parentID` hops from the session to its top-level root (0 = top-level).
 * Shares the `resolveChildSession` walk and cache, so pairing a duty
 * check with a depth read costs nothing extra. Same fail-closed contract:
 * empty sessionID, missing getter, or any lookup failure yields null
 * (unknown) rather than a misleading partial count. Never throws.
 */
export async function resolveSessionDepth(
  sessionID: string,
  getSession?: (id: string) => Promise<SessionParentInfo | null | undefined>,
): Promise<number | null> {
  return (await resolveChildSession(sessionID, getSession)).depth;
}

export function setSessionDirectory(sessionID: string, directory: string): void {
  sessionToDirectory.set(sessionID, directory);
}

export function getDirectoryForSession(sessionID: string): string | null {
  return sessionToDirectory.get(sessionID) ?? null;
}

/** Session IDs already given their startup mention. In-memory like the
 * directory map, so an opencode restart/reload naturally re-arms it. */
const sessionStartSeen = new Set<string>();

/** Forget a session's directory mapping (called on `session.deleted`). */
export function clearSessionDirectory(sessionID: string): void {
  sessionToDirectory.delete(sessionID);
  sessionStartSeen.delete(sessionID);
  // A deleted session's verdict must never outlive it: IDs are unique per
  // session, so this is just hygiene against unbounded growth — but a stale
  // `true` here would wrongly exempt, and a stale `false` wrongly gate, a
  // hypothetical ID reuse. Match the existing per-session eviction contract.
  childSessionCache.delete(sessionID);
}

export function hasSeenSessionStart(sessionID: string): boolean {
  return sessionStartSeen.has(sessionID);
}

export function markSessionStartSeen(sessionID: string): void {
  sessionStartSeen.add(sessionID);
}

/** Reset all in-memory registries. Intended for test cleanup between
 *  test runs so stale session-to-directory mappings do not bleed
 *  `getStateForSession` into the next test. */
export function resetRegistry(): void {
  sessionToDirectory.clear();
  sessionStartSeen.clear();
  childSessionCache.clear();
  hookRegistry.clear();
  activeDirectory = null;
}
