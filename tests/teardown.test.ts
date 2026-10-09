import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache } from "../src/config";
import plugin from "../src/index";

// Hermetic stub: no child process ever spawns from this file. `setup()`
// hardwires the real spawner (src/index.ts `run: runCommand`), so without
// this every idle-triggered gate would shell out to real `git`/`false` —
// the only test file in the suite that did. `false` mimics /bin/false
// (exit 1, gate-failing); `git` mimics "not a repo" so gitChangedFiles
// fails fast to [] exactly as it does in these temp dirs.
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

  function createQueueSource() {
    // Adversarial event stream: abort-ignorant by design. Parking on an
    // empty queue forever (unless push()ed) simulates a core stream that
    // survives teardown, so the stale-loop guard (`activeState !== state`)
    // is what must contain it — the worst case for the strain probe.
    const queue: unknown[] = [];
    let wake: (() => void) | null = null;
    return {
      push(event: unknown) {
        queue.push(event);
        wake?.();
        wake = null;
      },
      async *iterate(): AsyncGenerator<unknown, void, unknown> {
        while (true) {
          while (queue.length === 0) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
          const next = queue.shift();
          if (next !== undefined) yield next;
        }
      },
    };
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForPromptCalls(
    prompt: unknown,
    expected: number,
    // Below the default vitest 5s test timeout on purpose: on failure the
    // terminal expect below must be what reports, not a framework timeout.
    timeoutMs = 3000,
  ): Promise<void> {
    const mock = prompt as { mock: { calls: unknown[][] } };
    const deadline = Date.now() + timeoutMs;
    // `<` (not `!==`): an overshoot is already a failure — fail fast
    // instead of spinning the full timeout before the expect fires.
    while (mock.mock.calls.length < expected && Date.now() < deadline) {
      await sleep(25);
    }
    expect(mock.mock.calls.length).toBe(expected);
  }

  function createMockCtx(subscribe?: () => AsyncGenerator<unknown, void, unknown>) {
    const sessionHooks = new Map<string, (event: never) => Promise<void> | void>();
    const toolHooks = new Map<string, (event: never) => Promise<void> | void>();
    const permissionHooks = new Map<string, (event: never) => Promise<void> | void>();
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
      permission: {
        hook: vi.fn(async (name: string, callback: (event: never) => Promise<void> | void) => {
          permissionHooks.set(name, callback);
          return makeRegistration();
        }),
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
          // Abort-ignorant on purpose when a custom source is given (see
          // createQueueSource): the stream outlives teardown, so only the
          // stale-loop guard stands between a dead loop and double
          // enforcement. The default empty generator exits immediately.
          [Symbol.asyncIterator]: subscribe ?? async function* () {},
        }),
      },
      app: { version: "2.0.18" },
    };
    return { ctx, sessionHooks, toolHooks, permissionHooks, disposers };
  }

  it("execute.before is fail-open after teardown (no throw, session recoverable)", async () => {
    const { ctx, toolHooks, permissionHooks, disposers } = createMockCtx();
    const mod = plugin as unknown as { setup: (c: unknown) => Promise<unknown> };

    const cleanup = (await mod.setup(ctx)) as () => Promise<void> | void;
    expect(typeof cleanup).toBe("function");

    const guard = toolHooks.get("execute.before");
    expect(guard).toBeDefined();
    // Phase 24: per-edit lint hook must be registered (and disposed) too.
    expect(toolHooks.get("execute.after")).toBeDefined();
    // Phase 25: permission.evaluate spike hook must be registered too.
    expect(permissionHooks.get("evaluate")).toBeDefined();

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

  it("rapid setup/teardown cycles with in-flight streams leave no live stale loop (strain probe)", async () => {
    // Gate config that blocks on idle, so event-loop liveness is observable
    // via ctx.session.prompt: stubbed `false` exits 1 (no child process
    // ever spawns — see the host mock at the top of this file) and
    // skip_unchanged is off so the gate runs with no changed files.
    writeFileSync(
      join(directory, ".opencode-dev-framework.yml"),
      'profile: standard\ncommands:\n  typecheck: "false"\ngate:\n  run_typecheck: true\n  run_tests: false\n  skip_unchanged: false\n  block_on_failure: true\n',
    );
    clearConfigCache();
    const mod = plugin as unknown as { setup: (c: unknown) => Promise<unknown> };

    // Reload churn: five rapid setup/teardown pairs with hanging streams.
    const dead: Array<{
      ctx: { session: { prompt: unknown } };
      source: ReturnType<typeof createQueueSource>;
    }> = [];
    for (let i = 0; i < 5; i++) {
      const source = createQueueSource();
      const { ctx, disposers } = createMockCtx(() => source.iterate());
      const cleanup = (await mod.setup(ctx)) as Cleanup;
      expect(typeof cleanup).toBe("function");
      await cleanup();
      expect(disposers.length).toBeGreaterThan(0);
      for (const registration of disposers) {
        expect(registration.dispose).toHaveBeenCalledTimes(1);
      }
      dead.push({ ctx: ctx as unknown as { session: { prompt: unknown } }, source });
    }

    // Live setup after the churn.
    const liveSource = createQueueSource();
    const live = createMockCtx(() => liveSource.iterate());
    const cleanupLive = (await mod.setup(live.ctx)) as Cleanup;

    // Late events into every dead stream: the stale loops wake, see
    // `activeState !== state`, and exit — without re-prompting anywhere.
    for (const [i, d] of dead.entries()) {
      d.source.push({ type: "session.idle", sessionID: `stress-stale-${i}` });
    }
    await sleep(300);
    for (const d of dead) {
      expect(d.ctx.session.prompt).not.toHaveBeenCalled();
    }
    expect(live.ctx.session.prompt).not.toHaveBeenCalled();

    // The live loop still enforces: one failing-gate idle → one re-prompt.
    liveSource.push({ type: "session.idle", sessionID: "stress-live" });
    await waitForPromptCalls(live.ctx.session.prompt, 1);
    expect(live.ctx.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ sessionID: "stress-live" }),
    );
    // Quiescence: a double-firing loop would land its second prompt just
    // after the first — settle, then confirm the count is still exactly 1.
    await sleep(200);
    expect(live.ctx.session.prompt).toHaveBeenCalledTimes(1);

    await cleanupLive();
  });

  it("a throwing event subscriber neither breaks setup nor bricks the session", async () => {
    const mod = plugin as unknown as { setup: (c: unknown) => Promise<unknown> };

    // 1) subscribe() throws synchronously: the loop catches it, setup still
    // resolves, and the guardrail still works.
    const syncBoom = createMockCtx();
    syncBoom.ctx.event.subscribe = () => {
      throw new Error("subscribe boom");
    };
    const cleanupSync = (await mod.setup(syncBoom.ctx)) as Cleanup;
    expect(typeof cleanupSync).toBe("function");
    const syncGuard = syncBoom.toolHooks.get("execute.before");
    expect(syncGuard).toBeDefined();
    await expect(
      (syncGuard as (event: unknown) => Promise<void>)({
        tool: "read",
        input: { path: "README.md" },
        sessionID: "boom-sync",
      }),
    ).resolves.toBeUndefined();
    await cleanupSync();

    // 2) The stream throws mid-iteration (after one idle event): same
    // guarantees. The loop's catch + safeLog contain it — visible as an
    // "event loop error" stderr line from the real logger, which is
    // expected noise, not a failure.
    async function* midThrow(): AsyncGenerator<unknown, void, unknown> {
      yield { type: "session.idle", sessionID: "boom-live" };
      throw new Error("stream boom");
    }
    const midCtx = createMockCtx(midThrow);
    const cleanupMid = (await mod.setup(midCtx.ctx)) as Cleanup;
    expect(typeof cleanupMid).toBe("function");
    const midGuard = midCtx.toolHooks.get("execute.before");
    expect(midGuard).toBeDefined();
    await expect(
      (midGuard as (event: unknown) => Promise<void>)({
        tool: "read",
        input: { path: "README.md" },
        sessionID: "boom-mid",
      }),
    ).resolves.toBeUndefined();
    await sleep(200);
    await cleanupMid();
  });
});
