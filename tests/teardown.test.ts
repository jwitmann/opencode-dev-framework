import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache } from "../src/config";
import plugin from "../src/index";

describe("issue #1: teardown must not brick tool calls", () => {
  let directory: string;

  beforeEach(() => {
    clearConfigCache();
    directory = mkdtempSync(join(tmpdir(), "df-teardown-"));
    writeFileSync(join(directory, ".opencode-dev-framework.yml"), "profile: standard\n");
  });

  afterEach(() => {
    clearConfigCache();
    rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function createMockCtx() {
    const sessionHooks = new Map<string, (event: never) => Promise<void> | void>();
    const toolHooks = new Map<string, (event: never) => Promise<void> | void>();
    const disposers: Array<{ dispose: () => Promise<void> }> = [];
    const makeRegistration = () => {
      const registration = { dispose: vi.fn(async () => {}) };
      disposers.push(registration);
      return registration;
    };
    const ctx = {
      location: { directory },
      session: {
        hook: vi.fn(async (name: string, callback: (event: never) => Promise<void> | void) => {
          sessionHooks.set(name, callback);
          return makeRegistration();
        }),
        prompt: vi.fn(),
        synthetic: vi.fn(),
      },
      tool: {
        hook: vi.fn(async (name: string, callback: (event: never) => Promise<void> | void) => {
          toolHooks.set(name, callback);
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
      app: { version: "2.0.18" },
    };
    return { ctx, sessionHooks, toolHooks, disposers };
  }

  it("execute.before is fail-open after teardown (no throw, session recoverable)", async () => {
    const { ctx, toolHooks, disposers } = createMockCtx();
    const mod = plugin as unknown as { setup: (c: unknown) => Promise<unknown> };

    const cleanup = (await mod.setup(ctx)) as () => Promise<void> | void;
    expect(typeof cleanup).toBe("function");

    const guard = toolHooks.get("execute.before");
    expect(guard).toBeDefined();

    // Benign call before teardown should pass.
    await expect(
      (guard as (event: unknown) => Promise<void>)({
        tool: "read",
        input: { path: "README.md" },
        sessionID: "teardown-s1",
      }),
    ).resolves.toBeUndefined();

    // Teardown (e.g. session_move / plugin reload).
    await cleanup();

    // Every registration must have been disposed.
    expect(disposers.length).toBeGreaterThan(0);
    for (const registration of disposers) {
      expect(registration.dispose).toHaveBeenCalledTimes(1);
    }

    // The stale hook closure must NOT throw after teardown — this is the
    // exact issue #1 symptom (every tool call threw permanently).
    await expect(
      (guard as (event: unknown) => Promise<void>)({
        tool: "read",
        input: { path: "README.md" },
        sessionID: "teardown-s1",
      }),
    ).resolves.toBeUndefined();

    await expect(
      (guard as (event: unknown) => Promise<void>)({
        tool: "shell",
        input: { command: "echo hi" },
        sessionID: "teardown-s1",
      }),
    ).resolves.toBeUndefined();
  });

  it("a fresh setup after teardown guards again", async () => {
    const first = createMockCtx();
    const mod = plugin as unknown as { setup: (c: unknown) => Promise<unknown> };

    const cleanupFirst = (await mod.setup(first.ctx)) as () => Promise<void> | void;
    await cleanupFirst();

    // Second setup (fresh OpenCode init / reloaded plugin) must work.
    clearConfigCache();
    const second = createMockCtx();
    const cleanupSecond = (await mod.setup(second.ctx)) as () => Promise<void> | void;
    expect(typeof cleanupSecond).toBe("function");

    const guard = second.toolHooks.get("execute.before");
    expect(guard).toBeDefined();
    await expect(
      (guard as (event: unknown) => Promise<void>)({
        tool: "read",
        input: { path: "README.md" },
        sessionID: "teardown-s2",
      }),
    ).resolves.toBeUndefined();

    await cleanupSecond();
  });

  it("stale hook after reload is a no-op (no double-enforce when dispose is unsupported)", async () => {
    const mod = plugin as unknown as { setup: (c: unknown) => Promise<unknown> };

    // Simulate an older core where hook()/transform() return void (no
    // Registration): teardown cannot dispose, so the old closure outlives.
    function createNoDisposeCtx() {
      const toolHooks = new Map<string, (event: never) => Promise<void> | void>();
      const ctx = {
        location: { directory },
        session: {
          hook: async (name: string, callback: (event: never) => Promise<void> | void) => {
            void name;
            void callback;
            return undefined;
          },
          prompt: async () => {},
          synthetic: async () => {},
        },
        tool: {
          hook: async (name: string, callback: (event: never) => Promise<void> | void) => {
            toolHooks.set(name, callback);
            return undefined;
          },
          transform: async (callback: (editor: { add: (t: unknown) => void }) => void) => {
            callback({ add: () => {} });
            return undefined;
          },
        },
        event: {
          subscribe: () => ({
            [Symbol.asyncIterator]: async function* () {},
          }),
        },
        app: { version: "2.0.18" },
      };
      return { ctx, toolHooks };
    }

    const first = createNoDisposeCtx();
    const cleanupFirst = (await mod.setup(first.ctx)) as () => Promise<void> | void;
    const staleGuard = first.toolHooks.get("execute.before");
    expect(staleGuard).toBeDefined();

    // Reload without disposal (teardown clears state, setup installs new).
    await cleanupFirst();
    clearConfigCache();
    const second = createNoDisposeCtx();
    const cleanupSecond = (await mod.setup(second.ctx)) as () => Promise<void> | void;
    const liveGuard = second.toolHooks.get("execute.before");
    expect(liveGuard).toBeDefined();

    // A dangerous command the live guard must still block.
    const dangerous = {
      tool: "shell",
      input: { command: "rm -rf /tmp/should-never-run" },
      sessionID: "teardown-stale",
    };
    await expect((liveGuard as (event: unknown) => Promise<void>)(dangerous)).rejects.toThrow(
      /blocked/,
    );

    // The stale (superseded) hook must NOT double-enforce — it no-ops
    // (fail-open) even though disposal never happened.
    await expect(
      (staleGuard as (event: unknown) => Promise<void>)(dangerous),
    ).resolves.toBeUndefined();

    await cleanupSecond();
  });
});
