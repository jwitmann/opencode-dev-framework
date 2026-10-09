import { describe, expect, it } from "vitest";
import {
  BLOCK_COUNT_KEY_PREFIX,
  createBlockStore,
  STOP_SUPPORTED_KEY,
  type StorageLike,
} from "../src/block-store";

/** In-memory ctx.storage stub that records every key it sees. */
function stubStorage() {
  const data = new Map<string, unknown>();
  const seen: string[] = [];
  const storage = {
    data,
    seen,
    get: async (key: string) => {
      seen.push(`get:${key}`);
      return data.get(key) as never;
    },
    set: async (key: string, value: never) => {
      seen.push(`set:${key}`);
      data.set(key, value);
    },
    remove: async (key: string) => {
      seen.push(`remove:${key}`);
      data.delete(key);
    },
  };
  return { storage: storage as unknown as StorageLike, data, seen };
}

function throwingStorage(): StorageLike {
  return {
    get: async () => {
      throw new Error("storage down");
    },
    set: async () => {
      throw new Error("storage down");
    },
    remove: async () => {
      throw new Error("storage down");
    },
  };
}

describe("block store (Phase 23)", () => {
  it("counts 1-2-3 then clears back to zero (memory mode)", async () => {
    const store = createBlockStore(undefined);
    expect(await store.increment("s")).toBe(1);
    expect(await store.increment("s")).toBe(2);
    expect(await store.increment("s")).toBe(3);
    expect(await store.get("s")).toBe(3);
    await store.clear("s");
    expect(await store.get("s")).toBe(0);
    expect(store.size).toBe(0);
  });

  it("tracks sessions independently", async () => {
    const store = createBlockStore(undefined);
    await store.increment("a");
    await store.increment("a");
    await store.increment("b");
    expect(await store.get("a")).toBe(2);
    expect(await store.get("b")).toBe(1);
    expect(store.size).toBe(2);
  });

  it("namespaces keys by session and flag", async () => {
    const { storage, seen } = stubStorage();
    const store = createBlockStore(storage);
    await store.increment("sess-1");
    await store.setStopSupported();
    expect(seen).toContain(`set:${BLOCK_COUNT_KEY_PREFIX}sess-1`);
    expect(seen).toContain(`set:${STOP_SUPPORTED_KEY}`);
    expect(await store.getStopSupported()).toBe(true);
  });

  it("persists across two store instances over shared storage (reload)", async () => {
    const { storage } = stubStorage();
    const first = createBlockStore(storage);
    await first.increment("sess");
    await first.increment("sess");

    // Fresh setup after reload: a new store over the same storage continues 2 -> 3.
    const second = createBlockStore(storage);
    expect(await second.get("sess")).toBe(2);
    expect(await second.increment("sess")).toBe(3);
  });

  it("round-trips the stop-supported flag across instances", async () => {
    const { storage } = stubStorage();
    const first = createBlockStore(storage);
    expect(await first.getStopSupported()).toBe(false);
    await first.setStopSupported();

    const second = createBlockStore(storage);
    expect(await second.getStopSupported()).toBe(true);
  });

  it("falls back to memory when storage throws (and reports degraded)", async () => {
    const store = createBlockStore(throwingStorage());
    expect(store.isDegraded()).toBe(false);
    expect(await store.increment("s")).toBe(1);
    expect(await store.increment("s")).toBe(2);
    expect(await store.get("s")).toBe(2);
    await store.clear("s");
    expect(await store.get("s")).toBe(0);
    expect(store.isDegraded()).toBe(true);
    // Stop flag still works in memory.
    await store.setStopSupported();
    expect(await store.getStopSupported()).toBe(true);
  });

  it("ignores corrupt stored values instead of propagating them", async () => {
    const { storage, data } = stubStorage();
    data.set(`${BLOCK_COUNT_KEY_PREFIX}s`, "garbage");
    const store = createBlockStore(storage);
    expect(await store.get("s")).toBe(0);
    // Next increment starts from zero and overwrites the corrupt value.
    expect(await store.increment("s")).toBe(1);
  });

  it("write-through cache keeps the shared map live for status rendering", async () => {
    const { storage } = stubStorage();
    const shared = new Map<string, number>();
    const store = createBlockStore(storage, shared);
    await store.increment("s");
    expect(shared.get("s")).toBe(1);
    await store.clear("s");
    expect(shared.has("s")).toBe(false);
  });
});
