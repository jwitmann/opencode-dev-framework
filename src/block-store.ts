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
 * Stored values are only block counts (`number`) and one `boolean` flag.
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

function blockKey(sessionID: string): string {
  return `${BLOCK_COUNT_KEY_PREFIX}${sessionID}`;
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
  setStopSupported(): Promise<void>;
  /** True once any storage call has failed (in-memory fallback in use). */
  isDegraded(): boolean;
}

export function createBlockStore(
  storage: StorageLike | undefined | null,
  memory?: Map<string, number>,
): BlockStore {
  const counts = memory ?? new Map<string, number>();
  let stopMemory = false;
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
      if (stopMemory) return true;
      if (storage == null) return false;
      try {
        const stored = await storage.get(STOP_SUPPORTED_KEY);
        if (stored === true) {
          stopMemory = true;
          return true;
        }
        return false;
      } catch {
        degraded = true;
        return false;
      }
    },
    async setStopSupported(): Promise<void> {
      stopMemory = true;
      if (storage == null) return;
      try {
        await storage.set(STOP_SUPPORTED_KEY, true);
      } catch {
        degraded = true;
      }
    },
    isDegraded(): boolean {
      return degraded;
    },
  };
}
