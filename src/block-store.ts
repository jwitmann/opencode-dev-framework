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
 * Stored values are only block counts (`number`). Never store secrets,
 * prompts, or file contents here.
 *
 * Key namespacing: counts are keyed `df:blocks:<sessionID>` (OpenCode
 * session IDs are globally unique, so this is safe even if storage is
 * shared across projects).
 *
 * Historical note: pre-cutover builds persisted a `df:stopSupported` flag
 * recording which stopping probe fired. The idle-first cutover removed
 * that API; a stale key left by an older install is simply never read.
 */

import type { Context } from "@opencode/plugin/promise/plugin";

/** Minimal storage surface we need (subset of `Context["storage"]`). */
export type StorageLike = Pick<Context["storage"], "get" | "set" | "remove">;

export const BLOCK_COUNT_KEY_PREFIX = "df:blocks:";

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
  /** True once any storage call has failed (in-memory fallback in use). */
  isDegraded(): boolean;
}

export function createBlockStore(
  storage: StorageLike | undefined | null,
  memory?: Map<string, number>,
): BlockStore {
  const counts = memory ?? new Map<string, number>();
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
    isDegraded(): boolean {
      return degraded;
    },
  };
}
