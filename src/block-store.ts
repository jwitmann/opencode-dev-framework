/**
 * Persistent per-session completion-gate block counts.
 *
 * Counts live in `ctx.storage` (survives plugin reload / `session_move` /
 * server restart) with a caller-provided `Map` as the write-through L1
 * cache (keeps `/df-status` rendering and the synchronous status paths
 * working off live data). Every storage call is best-effort: on failure the
 * store falls back to memory, records `isDegraded()`, and never throws — so
 * a broken storage backend degrades to pre-Phase-23 behavior instead of
 * breaking the gate.
 *
 * Stored values are only block counts (`number`) and one stop-level flag
 * (`"stopping"` for the legacy probe, `"experimental.stopping"` for the V2
 * hook; pre-Phase-27 `true` reads back as the legacy level).
 * Never store secrets, prompts, or file contents here.
 *
 * Key namespacing: counts are keyed `df:blocks:<sessionID>` (OpenCode
 * session IDs are globally unique, so this is safe even if storage is
 * shared across projects); the hard-stop probe flag is `df:stopSupported`.
 */

import type { Context } from "@opencode/plugin/promise/plugin";

/** Minimal storage surface we need (subset of `Context["storage"]`). */
export type StorageLike = Pick<Context["storage"], "get" | "set" | "remove">;

export const BLOCK_COUNT_KEY_PREFIX = "df:blocks:";
export const STOP_SUPPORTED_KEY = "df:stopSupported";

/**
 * Which pre-terminal hook fired. `stopping` is the legacy V1-shape probe
 * (PR #44712); `experimental.stopping` is the V2 contract (single mutable
 * event, `decision` grant). The new hook outranks the old: once it has
 * fired, the level never downgrades back to the legacy probe.
 */
export type StopHookKind = "stopping" | "experimental.stopping";

function blockKey(sessionID: string): string {
  return `${BLOCK_COUNT_KEY_PREFIX}${sessionID}`;
}

function asStopKind(value: unknown): StopHookKind | null {
  if (value === "experimental.stopping") return "experimental.stopping";
  // Legacy boolean flag (pre-Phase-27) means the old probe fired.
  if (value === true || value === "stopping") return "stopping";
  return null;
}

function rank(kind: StopHookKind): number {
  return kind === "experimental.stopping" ? 1 : 0;
}

/** Accept only sane counts; anything else (foreign/corrupt value) is treated as missing. */
function asCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

export interface BlockStore {
  get(sessionID: string): Promise<number>;
  /** Read, add one, persist, and return the new count. */
  increment(sessionID: string): Promise<number>;
  clear(sessionID: string): Promise<void>;
  /** Live entries (mirrors the L1 map; used by tests). */
  readonly size: number;
  getStopSupported(): Promise<boolean>;
  /**
   * Record that a stopping hook fired. Defaults to the legacy `stopping`
   * probe (preserves pre-Phase-27 call sites); pass
   * `"experimental.stopping"` for the V2 hook. Monotonic: a stored new-hook
   * level is never downgraded by a later legacy-probe call.
   */
  setStopSupported(kind?: StopHookKind): Promise<void>;
  /** Which hook fired, or null when neither has (legacy `true` reads as the old probe). */
  getStopKind(): Promise<StopHookKind | null>;
  /** True once any storage call has failed (in-memory fallback in use). */
  isDegraded(): boolean;
}

export function createBlockStore(
  storage: StorageLike | undefined | null,
  memory?: Map<string, number>,
): BlockStore {
  const counts = memory ?? new Map<string, number>();
  let stopMemory: StopHookKind | null = null;
  let degraded = false;

  async function readCount(sessionID: string): Promise<number> {
    if (storage == null) return counts.get(sessionID) ?? 0;
    try {
      const stored = asCount(await storage.get(blockKey(sessionID)));
      if (stored !== undefined) {
        counts.set(sessionID, stored);
        return stored;
      }
      return counts.get(sessionID) ?? 0;
    } catch {
      degraded = true;
      return counts.get(sessionID) ?? 0;
    }
  }

  async function readStopKind(): Promise<StopHookKind | null> {
    if (stopMemory !== null) {
      // Memory already holds a level, but storage may hold a higher one
      // written by a newer setup sharing the backend — take the max.
      if (storage == null) return stopMemory;
      try {
        const stored = asStopKind(await storage.get(STOP_SUPPORTED_KEY));
        if (stored !== null && rank(stored) > rank(stopMemory)) {
          stopMemory = stored;
        }
        return stopMemory;
      } catch {
        degraded = true;
        return stopMemory;
      }
    }
    if (storage == null) return null;
    try {
      const stored = asStopKind(await storage.get(STOP_SUPPORTED_KEY));
      if (stored !== null) {
        stopMemory = stored;
      }
      return stored;
    } catch {
      degraded = true;
      return null;
    }
  }
  async function writeCount(sessionID: string, count: number): Promise<void> {
    counts.set(sessionID, count);
    if (storage == null) return;
    try {
      await storage.set(blockKey(sessionID), count);
    } catch {
      degraded = true;
    }
  }

  return {
    get(sessionID: string): Promise<number> {
      return readCount(sessionID);
    },
    async increment(sessionID: string): Promise<number> {
      const next = (await readCount(sessionID)) + 1;
      await writeCount(sessionID, next);
      return next;
    },
    async clear(sessionID: string): Promise<void> {
      counts.delete(sessionID);
      if (storage == null) return;
      try {
        await storage.remove(blockKey(sessionID));
      } catch {
        degraded = true;
      }
    },
    get size(): number {
      return counts.size;
    },
    async getStopSupported(): Promise<boolean> {
      return (await readStopKind()) !== null;
    },
    getStopKind(): Promise<StopHookKind | null> {
      return readStopKind();
    },
    async setStopSupported(kind: StopHookKind = "stopping"): Promise<void> {
      // Monotonic: never downgrade a recorded new-hook level.
      if (stopMemory !== null && rank(stopMemory) >= rank(kind)) {
        kind = stopMemory;
      } else {
        stopMemory = kind;
      }
      if (storage == null) return;
      try {
        const stored = asStopKind(await storage.get(STOP_SUPPORTED_KEY));
        const next = stored !== null && rank(stored) >= rank(kind) ? stored : kind;
        stopMemory = next;
        await storage.set(STOP_SUPPORTED_KEY, next);
      } catch {
        degraded = true;
      }
    },
    isDegraded(): boolean {
      return degraded;
    },
  };
}
