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

describe("experimental.stopping dogfood probe (§13.6)", () => {
  let directory: string;
  let cleanups: Cleanup[];

  beforeEach(() => {
    clearConfigCache();
    directory = mkdtempSync(join(tmpdir(), "df-stopping-"));
    cleanups = [];
  });

  afterEach(async () => {
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
    const ctx = {
      location: { directory },
      storage,
      session: {
        hook: vi.fn(async (name: string, callback: (event: never) => Promise<void> | void) => {
          sessionHooks.set(name, callback);
          return makeRegistration();
        }),
        prompt: vi.fn(),
        synthetic: vi.fn(),
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
        subscribe: () => ({
          [Symbol.asyncIterator]: async function* () {},
        }),
      },
      app: { version: "2.0.26" },
    };
    return { ctx, sessionHooks, disposers };
  }

  async function setupWith(configYml: string) {
    writeFileSync(join(directory, ".opencode-dev-framework.yml"), configYml);
    clearConfigCache();
    const { storage } = stubStorage();
    const { ctx, sessionHooks, disposers } = createMockCtx(storage);
    const mod = plugin as unknown as { setup: (c: unknown) => Promise<unknown> };
    const cleanup = (await mod.setup(ctx)) as Cleanup;
    cleanups.push(cleanup);
    return { ctx, sessionHooks, disposers, storage };
  }

  function vote(sessionID: string, extra: Record<string, unknown> = {}) {
    return {
      sessionID,
      step: 3,
      continuations: 0,
      decision: { shouldContinue: false as const },
      ...extra,
    };
  }

  it("registers experimental.stopping alongside the legacy stopping probe", async () => {
    const { sessionHooks } = await setupWith(FAILING_YML);
    expect(sessionHooks.has("stopping"), "legacy stopping probe registered").toBe(true);
    expect(sessionHooks.has("experimental.stopping"), "V2 hook registered").toBe(true);
  });

  it("fail → grant shape (decision carries the steer text)", async () => {
    const { sessionHooks } = await setupWith(FAILING_YML);
    const hook = sessionHooks.get("experimental.stopping");
    expect(hook).toBeDefined();

    const event = vote("fail-grant-s1");
    await (hook as (event: unknown) => Promise<void>)(event);

    expect(event.decision).toEqual({
      shouldContinue: true,
      text: expect.stringContaining("completion gate blocked"),
    });
    // The vote's own fields are preserved, not rewritten by the voter.
    expect(event.sessionID).toBe("fail-grant-s1");
    expect(event.step).toBe(3);
    expect(event.continuations).toBe(0);
  });

  it("pass → abstain (fail-closed default left untouched)", async () => {
    const { sessionHooks } = await setupWith(PASSING_YML);
    const hook = sessionHooks.get("experimental.stopping");
    expect(hook).toBeDefined();

    const event = vote("pass-abstain-s1");
    await (hook as (event: unknown) => Promise<void>)(event);

    expect(event.decision).toEqual({ shouldContinue: false });
  });

  it("observes the pre-increment continuations count; local max_blocks stand-down abstains", async () => {
    const yml = `profile: standard
commands:
  typecheck: "false"
gate:
  run_typecheck: true
  run_tests: false
  skip_unchanged: false
  block_on_failure: true
  max_blocks: 1
`;
    const { sessionHooks } = await setupWith(yml);
    const hook = sessionHooks.get("experimental.stopping");
    expect(hook).toBeDefined();
    const fire = hook as (event: unknown) => Promise<void>;

    // First vote (core pre-increment count 0): local gate blocks → grant.
    const first = vote("standdown-s1", { continuations: 0 });
    await fire(first);
    expect(first.decision).toEqual({
      shouldContinue: true,
      text: expect.stringContaining("(Block 1/1 this session.)"),
    });

    // Second vote (core pre-increment count 1): the verdict runner's own
    // max_blocks stand-down fires first — the voter abstains rather than
    // fighting the core cap with another grant.
    const second = vote("standdown-s1", { continuations: 1 });
    await fire(second);
    expect(second.decision).toEqual({ shouldContinue: false });
  });

  it("legacy stopping probe still maps fail → stop=false + message", async () => {
    const { sessionHooks } = await setupWith(FAILING_YML);
    const hook = sessionHooks.get("stopping");
    expect(hook).toBeDefined();

    const input = { sessionID: "legacy-s1" };
    await (hook as (event: unknown) => Promise<void>)(input);

    expect(input).toMatchObject({
      stop: false,
      message: expect.stringContaining("completion gate blocked"),
    });
  });

  it("stop level is monotonic: new hook outranks the legacy probe", async () => {
    const { sessionHooks, storage } = await setupWith(FAILING_YML);
    const fire = async (name: string, event: unknown) => {
      const hook = sessionHooks.get(name);
      expect(hook, `${name} registered`).toBeDefined();
      await (hook as (event: unknown) => Promise<void>)(event);
    };

    // Legacy first, then V2 → level upgrades to the new hook.
    await fire("stopping", { sessionID: "order-s1" });
    const store = createBlockStore(storage);
    expect(await store.getStopKind()).toBe("stopping");

    await fire("experimental.stopping", vote("order-s1", { continuations: 1 }));
    expect(await store.getStopKind()).toBe("experimental.stopping");

    // Late legacy dispatch never downgrades a recorded new-hook level.
    await fire("stopping", { sessionID: "order-s1" });
    expect(await store.getStopKind()).toBe("experimental.stopping");
  });

  it("status reporting distinguishes none → idle → old probe → new hook", async () => {
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

    // none: config-only rendering carries no enforcement line.
    expect(renderStatus(config)).not.toContain("Hard stop");

    // idle-fallback: live state, no hook dispatched yet.
    expect(renderStatus(config, fakeState({}))).toContain(
      "Hard stop (stopping / experimental.stopping): not dispatched by this OpenCode build — idle re-prompt fallback",
    );

    // old probe fired.
    expect(
      renderStatus(config, fakeState({ stopHookSupported: true, stopHookKind: "stopping" })),
    ).toContain("Hard stop (stopping): active — gate vetoes loop exit (legacy probe)");

    // new hook fired.
    expect(
      renderStatus(
        config,
        fakeState({ stopHookSupported: true, stopHookKind: "experimental.stopping" }),
      ),
    ).toContain(
      "Hard stop (experimental.stopping): active — gate failures continue the turn with steer text",
    );
  });
});

describe("stop-level persistence (block store)", () => {
  it("defaults to the legacy probe level and round-trips the new-hook level", async () => {
    const { storage } = stubStorage();
    const first = createBlockStore(storage);
    expect(await first.getStopKind()).toBe(null);
    expect(await first.getStopSupported()).toBe(false);

    await first.setStopSupported();
    expect(await first.getStopKind()).toBe("stopping");
    expect(await first.getStopSupported()).toBe(true);

    await first.setStopSupported("experimental.stopping");
    expect(await first.getStopKind()).toBe("experimental.stopping");

    // A fresh store over the same storage sees the persisted level.
    const second = createBlockStore(storage);
    expect(await second.getStopKind()).toBe("experimental.stopping");
  });

  it("never downgrades the new-hook level with a later legacy call", async () => {
    const { storage } = stubStorage();
    const store = createBlockStore(storage);
    await store.setStopSupported("experimental.stopping");
    await store.setStopSupported("stopping");
    expect(await store.getStopKind()).toBe("experimental.stopping");
  });

  it("reads a pre-Phase-27 boolean flag as the legacy probe level", async () => {
    const { storage, data } = stubStorage();
    data.set("df:stopSupported", true);
    const store = createBlockStore(storage);
    expect(await store.getStopKind()).toBe("stopping");
    expect(await store.getStopSupported()).toBe(true);
  });
});
