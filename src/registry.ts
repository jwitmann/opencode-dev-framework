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
 * Child-session verdicts: sessionID → true when the session has a parent
 * (i.e. it is a subagent and never owns review duty). Populated lazily via
 * `resolveIsChildSession` and cleared with everything else in
 * `resetRegistry`. Memory-only like the directory map.
 */
const childSessionCache = new Map<string, boolean>();

/** Structural parent link returned by the host session lookup. */
export interface SessionParentInfo {
  parentID?: string | null | undefined;
}

/**
 * True when the session is a child (subagent): its host record carries a
 * parentID. Results are cached per sessionID. Fails closed to `false`
 * (top-level): a missing getter (older core), an empty sessionID, or a
 * lookup throw preserves the pre-guard behavior exactly — the session is
 * gated and may write, as before. Never throws.
 */
export async function resolveIsChildSession(
  sessionID: string,
  getSession?: (id: string) => Promise<SessionParentInfo | null | undefined>,
): Promise<boolean> {
  if (sessionID === "") return false;
  const cached = childSessionCache.get(sessionID);
  if (cached !== undefined) return cached;
  let isChild = false;
  if (getSession === undefined) return false;
  try {
    const info = await getSession(sessionID);
    // Cache only successful lookups that actually resolved a session:
    // a throw or a nullish info (unknown to the host) returns top-level
    // WITHOUT caching, so one transient failure can never permanently pin
    // a child as top-level (which would re-enable the original bug).
    if (info !== null && info !== undefined) {
      const parent = info.parentID;
      isChild = typeof parent === "string" && parent !== "";
      childSessionCache.set(sessionID, isChild);
    }
    return isChild;
  } catch {
    return false;
  }
}

/**
 * Best-effort session-tree depth for the plan-24 tripwire: the number of
 * `parentID` hops from the session to its top-level root (0 = top-level).
 * Logged on child-gated decisions so the first real nesting shows up in
 * the log instead of passing silently. Uncapped by policy — the visited
 * set only guards against a pathological cycle, which the core API cannot
 * currently produce (no `parentID` mutation; creation with an unknown
 * parent is rejected). Never throws and never caches: an empty sessionID
 * or missing getter yields null (unknown), any lookup failure abandons
 * the walk and yields null rather than a misleading partial count, and
 * the call sites are rare (idle boundaries, artifact writes) so
 * freshness beats memoization.
 */
export async function resolveSessionDepth(
  sessionID: string,
  getSession?: (id: string) => Promise<SessionParentInfo | null | undefined>,
): Promise<number | null> {
  if (sessionID === "" || getSession === undefined) return null;
  const seen = new Set<string>([sessionID]);
  let depth = 0;
  let current = sessionID;
  try {
    while (true) {
      const parent = (await getSession(current))?.parentID;
      if (typeof parent !== "string" || parent === "" || seen.has(parent)) break;
      seen.add(parent);
      depth++;
      current = parent;
    }
    return depth;
  } catch {
    return null;
  }
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
