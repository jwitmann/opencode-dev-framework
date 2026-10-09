import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache } from "../src/config";
import plugin from "../src/index";

interface EvalEvent {
  sessionID: string;
  action: string;
  resources: string[];
  effect: string;
  message?: string;
}

describe("Phase 25: permission.hook(evaluate) native layer", () => {
  let directory: string;
  let cleanup: (() => Promise<void> | void) | undefined;

  function writeConfig(body: string): void {
    writeFileSync(join(directory, ".opencode-dev-framework.yml"), body);
  }

  function standardConfig(): string {
    return 'profile: standard\nprotect:\n  - ".env*"\n';
  }

  function createMockCtx() {
    const permissionHooks = new Map<string, (event: never) => Promise<void> | void>();
    const ctx = {
      location: { directory },
      session: {
        hook: vi.fn(async () => ({ dispose: async () => {} })),
        prompt: vi.fn(),
        synthetic: vi.fn(),
      },
      permission: {
        hook: vi.fn(async (name: string, callback: (event: never) => Promise<void> | void) => {
          permissionHooks.set(name, callback);
          return { dispose: async () => {} };
        }),
      },
      tool: {
        hook: vi.fn(async () => ({ dispose: async () => {} })),
        transform: vi.fn(async (callback: (editor: { add: (t: unknown) => void }) => void) => {
          callback({ add: () => {} });
          return { dispose: async () => {} };
        }),
      },
      event: {
        subscribe: () => ({
          [Symbol.asyncIterator]: async function* () {},
        }),
      },
      app: { version: "2.0.26" },
    };
    return { ctx, permissionHooks };
  }

  async function setup(configBody: string) {
    writeConfig(configBody);
    const mocks = createMockCtx();
    const mod = plugin as unknown as { setup: (c: unknown) => Promise<unknown> };
    cleanup = (await mod.setup(mocks.ctx)) as () => Promise<void> | void;
    const evaluate = mocks.permissionHooks.get("evaluate");
    expect(evaluate).toBeDefined();
    return { ...mocks, evaluateHook: evaluate as (event: EvalEvent) => Promise<void> };
  }

  function makeEvent(over: Partial<EvalEvent> & { action: string }): EvalEvent {
    return {
      sessionID: "perm-s1",
      resources: [],
      effect: "allow",
      ...over,
    };
  }

  beforeEach(() => {
    clearConfigCache();
    directory = mkdtempSync(join(tmpdir(), "df-perm-"));
  });

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
    clearConfigCache();
    rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("deny + message: protected-path edit is denied with a reason", async () => {
    const { evaluateHook } = await setup(standardConfig());
    const event = makeEvent({ action: "edit", resources: [".env.probe"] });
    await evaluateHook(event);
    expect(event.effect).toBe("deny");
    expect(event.message).toContain("protected path");
  });

  it("deny + message: dangerous shell command is denied with a reason", async () => {
    const { evaluateHook } = await setup(standardConfig());
    const event = makeEvent({ action: "shell", resources: ["rm -rf /tmp/x"] });
    await evaluateHook(event);
    expect(event.effect).toBe("deny");
    expect(event.message).toContain("rm -rf");
  });

  it("advisory warns but leaves the engine verdict untouched", async () => {
    const { evaluateHook } = await setup('profile: advisory\nprotect:\n  - ".env*"\n');
    const editEvent = makeEvent({ action: "edit", resources: [".env.probe"] });
    await evaluateHook(editEvent);
    expect(editEvent.effect).toBe("allow");
    expect(editEvent.message).toBeUndefined();
    const shellEvent = makeEvent({ action: "shell", resources: ["rm -rf /tmp/x"] });
    await evaluateHook(shellEvent);
    expect(shellEvent.effect).toBe("allow");
    expect(shellEvent.message).toBeUndefined();
  });

  it("allowed calls pass through untouched (engine default wins)", async () => {
    const { evaluateHook } = await setup(standardConfig());
    const editEvent = makeEvent({ action: "edit", resources: ["src/a.ts"] });
    await evaluateHook(editEvent);
    expect(editEvent.effect).toBe("allow");
    expect(editEvent.message).toBeUndefined();
    const shellEvent = makeEvent({ action: "shell", resources: ["echo hi"] });
    await evaluateHook(shellEvent);
    expect(shellEvent.effect).toBe("allow");
    expect(shellEvent.message).toBeUndefined();
  });

  it("never weakens enforcement: engine denies stay denied", async () => {
    const { evaluateHook } = await setup(standardConfig());
    const event = makeEvent({ action: "edit", resources: ["src/a.ts"], effect: "deny" });
    event.message = "host denied";
    await evaluateHook(event);
    expect(event.effect).toBe("deny");
    expect(event.message).toBe("host denied");
  });

  it("already-denied calls abstain even when guardrails would also deny (host message wins)", async () => {
    const { evaluateHook } = await setup(standardConfig());
    const event = makeEvent({ action: "edit", resources: [".env.probe"], effect: "deny" });
    event.message = "host denied this path";
    await evaluateHook(event);
    expect(event.effect).toBe("deny");
    expect(event.message).toBe("host denied this path");
  });

  it("unknown actions and empty resources abstain", async () => {
    const { evaluateHook } = await setup(standardConfig());
    const unknown = makeEvent({ action: "read", resources: ["src/a.ts"] });
    await evaluateHook(unknown);
    expect(unknown.effect).toBe("allow");
    expect(unknown.message).toBeUndefined();
    const empty = makeEvent({ action: "edit", resources: [] });
    await evaluateHook(empty);
    expect(empty.effect).toBe("allow");
    expect(empty.message).toBeUndefined();
  });

  it("off profile is a no-op", async () => {
    const { evaluateHook } = await setup("profile: off\n");
    const event = makeEvent({ action: "edit", resources: [".env.probe"] });
    await evaluateHook(event);
    expect(event.effect).toBe("allow");
    expect(event.message).toBeUndefined();
  });

  it("preflight pending denies edits (mirrors execute.before)", async () => {
    const { evaluateHook } = await setup(
      'profile: standard\npreflight:\n  - "Review the diff before editing"\n',
    );
    const event = makeEvent({ action: "edit", resources: ["src/a.ts"] });
    await evaluateHook(event);
    expect(event.effect).toBe("deny");
    expect(event.message).toContain("pre-flight");
  });

  it("stale hook after teardown is a no-op (never denies)", async () => {
    const { evaluateHook } = await setup(standardConfig());
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
    const event = makeEvent({ action: "edit", resources: [".env.probe"] });
    await expect(evaluateHook(event)).resolves.toBeUndefined();
    expect(event.effect).toBe("allow");
    expect(event.message).toBeUndefined();
  });
});
