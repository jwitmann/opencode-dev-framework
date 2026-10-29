import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBlockStore, type StorageLike } from "../src/block-store";
import { clearConfigCache, loadConfig } from "../src/config";
import { renderStatus } from "../src/format-status";
import { createChangedFileTracker } from "../src/gate";
import plugin from "../src/index";
import type { HookState } from "../src/registry";

// Hermetic stub (same idiom as tests/teardown.test.ts): no child process
// ever spawns. `false` mimics /bin/false (exit 1, gate-failing); `git`
// mimics "not a repo" so gitChangedFiles fails fast to []; everything else
// passes (so `true` is a gate-passing typecheck).
vi.mock("../src/host", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/host")>();
  const runCommand: typeof original.runCommand = async (command) => {
    if (command[0] === "false") {
      return { stdout: "", stderr: "", exitCode: 1, timedOut: false };
    }
    if (command[0] === "git") {
      return { stdout: "", stderr: "not a git repo", exitCode: 128, timedOut: false };
    }
    return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
  };
  return { ...original, runCommand };
});

type Cleanup = () => Promise<void> | void;

/** In-memory ctx.storage stub (same idiom as tests/block-store.test.ts). */
function stubStorage() {
  const data = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => data.get(key) as never,
    set: async (key: string, value: never) => {
      data.set(key, value);
    },
    remove: async (key: string) => {
      data.delete(key);
    },
  };
  return { storage: storage as unknown as StorageLike, data };
}

const FAILING_YML = `profile: standard
commands:
  typecheck: "false"
gate:
  run_typecheck: true
  run_tests: false
  skip_unchanged: false
  block_on_failure: true
`;

const PASSING_YML = `profile: standard
commands:
  typecheck: "true"
gate:
  run_typecheck: true
  run_tests: false
  skip_unchanged: false
  block_on_failure: true
`;

describe("idle-first continuation (§12 cutover)", () => {
  let directory: string;
  let cleanups: Cleanup[];
  // Gate released by each test when its subscriber stream may deliver.
  let releaseEvents: () => void;
  let gatePromise: Promise<void>;

  beforeEach(() => {
    clearConfigCache();
    directory = mkdtempSync(join(tmpdir(), "df-idle-"));
    cleanups = [];
    gatePromise = new Promise<void>((resolve) => {
      releaseEvents = resolve;
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const cleanup of cleanups) {
      await cleanup();
    }
    clearConfigCache();
    rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function createMockCtx(storage: StorageLike) {
    const sessionHooks = new Map<string, (event: never) => Promise<void> | void>();
    const disposers: Array<{ dispose: () => Promise<void> }> = [];
    const makeRegistration = () => {
      const registration = { dispose: vi.fn(async () => {}) };
      disposers.push(registration);
      return registration;
    };
    const synthetic = vi.fn(async (_input: { sessionID: string; text?: string }) => ({}));
    const prompt = vi.fn(async (_input: { sessionID: string; text?: string }) => ({}));
    const release = () => releaseEvents();
    const ctx = {
      location: { directory },
      storage,
      session: {
        hook: vi.fn(async (name: string, callback: (event: never) => Promise<void> | void) => {
          sessionHooks.set(name, callback);
          return makeRegistration();
        }),
        prompt,
        synthetic,
      },
      permission: {
        hook: vi.fn(async (name: string, callback: (event: never) => Promise<void> | void) => {
          void name;
          void callback;
          return makeRegistration();
        }),
      },
      tool: {
        hook: vi.fn(async (name: string, callback: (event: never) => Promise<void> | void) => {
          void name;
          void callback;
          return makeRegistration();
        }),
        transform: vi.fn(async (callback: (editor: { add: (t: unknown) => void }) => void) => {
          callback({ add: () => {} });
          return makeRegistration();
        }),
      },
      event: {
        // The idle net only sees what the test releases: the stream parks
        // until the test calls `release()`, so hook fires never race it.
        subscribe: () => ({
          [Symbol.asyncIterator]: async function* () {
            await gatePromise;
            yield { type: "session.idle", data: { sessionID: "net-s1" } };
          },
        }),
      },
      app: { version: "2.0.26" },
    };
    return { ctx, sessionHooks, disposers, synthetic, prompt, release };
  }

  async function setupWith(configYml: string) {
    writeFileSync(join(directory, ".opencode-dev-framework.yml"), configYml);
    clearConfigCache();
    const { storage } = stubStorage();
    const { ctx, sessionHooks, disposers, synthetic, prompt, release } = createMockCtx(storage);
    const mod = plugin as unknown as { setup: (c: unknown) => Promise<unknown> };
    const cleanup = (await mod.setup(ctx)) as Cleanup;
    cleanups.push(cleanup);
    return { ctx, sessionHooks, disposers, storage, synthetic, prompt, release };
  }

  function idleEvent(sessionID: string, extra: Record<string, unknown> = {}) {
    return { sessionID, background: [], ...extra };
  }

  async function waitForCalls(fn: () => number, want: number, polls = 300) {
    for (let i = 0; i < polls && fn() < want; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (fn() < want) throw new Error(`timed out waiting for ${want} calls`);
  }

  it("registers experimental.idle plus the idle alias", async () => {
    const { sessionHooks } = await setupWith(FAILING_YML);
    expect(sessionHooks.has("experimental.idle"), "landed hook registered").toBe(true);
    expect(sessionHooks.has("idle"), "forward-compat alias registered").toBe(true);
  });

  it("blocked → synthetic called with continuationMessage, blockCount+1", async () => {
    const { sessionHooks, storage, synthetic } = await setupWith(FAILING_YML);
    const hook = sessionHooks.get("experimental.idle");
    expect(hook).toBeDefined();
    const fire = hook as (event: unknown) => Promise<void>;

    await fire(idleEvent("blocked-s1"));
    await waitForCalls(() => synthetic.mock.calls.length, 1);
    expect(synthetic).toHaveBeenCalledTimes(1);
    expect(synthetic.mock.calls[0]?.[0]).toMatchObject({
      sessionID: "blocked-s1",
      text: expect.stringContaining("completion gate blocked"),
    });
    const first = synthetic.mock.calls[0]?.[0] as { text?: string } | undefined;
    expect(first?.text).toContain("(block 1/3)");
    expect(await createBlockStore(storage).get("blocked-s1")).toBe(1);

    // A new boundary after the double-fire window blocks again (count+1).
    // Fake only Date: the gate path may need real timers, but the stamp
    // check reads Date.now().
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 1500);
    try {
      await fire(idleEvent("blocked-s1"));
    } finally {
      vi.useRealTimers();
    }
    await waitForCalls(() => synthetic.mock.calls.length, 2);
    expect(synthetic).toHaveBeenCalledTimes(2);
    const second = synthetic.mock.calls[1]?.[0] as { text?: string } | undefined;
    expect(second?.text).toContain("(block 2/3)");
  });

  it("pass → no synthetic, counts cleared", async () => {
    const { sessionHooks, synthetic } = await setupWith(PASSING_YML);
    const hook = sessionHooks.get("experimental.idle");
    expect(hook).toBeDefined();

    await (hook as (event: unknown) => Promise<void>)(idleEvent("pass-s1"));
    // Let any stray admit land if the handler misbehaves.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(synthetic).not.toHaveBeenCalled();
  });

  it("hook throw → no synthetic, no handled-stamp (subscriber net retries)", async () => {
    const { sessionHooks, synthetic, release } = await setupWith(FAILING_YML);
    const hook = sessionHooks.get("experimental.idle");
    expect(hook).toBeDefined();
    const fire = hook as (event: unknown) => Promise<void>;

    // Reading the event blows up mid-handler — must abstain, unstamped.
    const poisoned = {
      background: [],
      get sessionID(): string {
        throw new Error("core field boom");
      },
    };
    await expect(fire(poisoned)).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(synthetic).not.toHaveBeenCalled();

    // The subscriber net has no stamp to skip on, so it runs the gate.
    release();
    await waitForCalls(() => synthetic.mock.calls.length, 1);
    expect(synthetic.mock.calls[0]?.[0]).toMatchObject({
      sessionID: "net-s1",
      text: expect.stringContaining("completion gate blocked"),
    });
  });

  it("subscriber skips when the hook stamp is fresh", async () => {
    const { sessionHooks, synthetic, release } = await setupWith(FAILING_YML);
    const hook = sessionHooks.get("experimental.idle");
    expect(hook).toBeDefined();

    await (hook as (event: unknown) => Promise<void>)(idleEvent("net-s1"));
    await waitForCalls(() => synthetic.mock.calls.length, 1);
    synthetic.mockClear();

    release();
    // Give the net every chance to double-run the gate, then assert quiet.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(synthetic).not.toHaveBeenCalled();
  });

  it("subscriber runs when the stamp is stale", async () => {
    const { sessionHooks, synthetic, release } = await setupWith(FAILING_YML);
    const hook = sessionHooks.get("experimental.idle");
    expect(hook).toBeDefined();

    await (hook as (event: unknown) => Promise<void>)(idleEvent("net-s1"));
    await waitForCalls(() => synthetic.mock.calls.length, 1);
    synthetic.mockClear();

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 6000);
    release();
    try {
      await waitForCalls(() => synthetic.mock.calls.length, 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("status reporting distinguishes fallback from idle", async () => {
    clearConfigCache();
    writeFileSync(join(directory, ".opencode-dev-framework.yml"), FAILING_YML);
    const config = loadConfig(directory);

    function fakeState(overrides: Partial<HookState>): HookState {
      return {
        directory,
        config,
        log: async () => {},
        run: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
        tracker: createChangedFileTracker(),
        constitution: null,
        blockCounts: new Map<string, number>(),
        ...overrides,
      } as HookState;
    }

    // config-only rendering carries no enforcement line.
    expect(renderStatus(config)).not.toContain("Continuation (idle)");

    // No hook completed an evaluation yet → fallback net.
    expect(renderStatus(config, fakeState({}))).toContain(
      "Continuation (idle): not dispatched — event-subscribe fallback",
    );

    // Hook completed an evaluation → same-execution continuation active.
    expect(renderStatus(config, fakeState({ continuationLevel: "idle" }))).toContain(
      "Continuation (idle): active",
    );
  });
});
