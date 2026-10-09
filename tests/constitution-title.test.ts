import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache } from "../src/config";
import plugin from "../src/index";

describe("constitution injection on title hook (Phase 22)", () => {
  let directory: string;

  beforeEach(() => {
    clearConfigCache();
    directory = mkdtempSync(join(tmpdir(), "df-title-"));
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
      app: { version: "2.0.26" },
    };
    return { ctx, sessionHooks, toolHooks, disposers };
  }

  it("registers context, generate, compaction, title, stopping and execute.before hooks", async () => {
    const { ctx, sessionHooks, toolHooks } = createMockCtx();
    const mod = plugin as unknown as { setup: (c: unknown) => Promise<unknown> };

    const cleanup = (await mod.setup(ctx)) as () => Promise<void> | void;
    expect(typeof cleanup).toBe("function");

    for (const name of ["context", "generate", "compaction", "title", "stopping"]) {
      expect(sessionHooks.has(name), `session hook ${name} registered`).toBe(true);
    }
    expect(toolHooks.has("execute.before")).toBe(true);

    await cleanup();
  });

  it("injects the constitution into title system prompts exactly once", async () => {
    const { ctx, sessionHooks } = createMockCtx();
    const mod = plugin as unknown as { setup: (c: unknown) => Promise<unknown> };

    const cleanup = (await mod.setup(ctx)) as () => Promise<void> | void;
    const titleHook = sessionHooks.get("title");
    expect(titleHook).toBeDefined();

    const event = { system: [{ type: "text", text: "hello" }] };
    await (titleHook as (event: unknown) => Promise<void>)(event);
    expect(event.system).toHaveLength(2);
    expect(event.system[1].text).toContain("Activation Gate");

    // Second call with the same event is idempotent — no duplicate injection.
    await (titleHook as (event: unknown) => Promise<void>)(event);
    expect(event.system).toHaveLength(2);

    await cleanup();
  });

  it("skips title injection when profile is off", async () => {
    writeFileSync(join(directory, ".opencode-dev-framework.yml"), "profile: off\n");
    clearConfigCache();
    const { ctx, sessionHooks } = createMockCtx();
    const mod = plugin as unknown as { setup: (c: unknown) => Promise<unknown> };

    const cleanup = (await mod.setup(ctx)) as () => Promise<void> | void;
    const titleHook = sessionHooks.get("title");
    expect(titleHook).toBeDefined();

    const event = { system: [{ type: "text", text: "hello" }] };
    await (titleHook as (event: unknown) => Promise<void>)(event);
    expect(event.system).toHaveLength(1);
    expect(event.system[0].text).toBe("hello");

    await cleanup();
  });
});
