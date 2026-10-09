import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache } from "../src/config";
import plugin from "../src/index";

describe("Phase 24: per-edit lint via tool.hook(execute.after)", () => {
  let directory: string;
  let cleanup: (() => Promise<void> | void) | undefined;

  /** Lint command writes a marker file: observable proof the linter ran. */
  function markerPath(): string {
    return join(directory, "lint-marker");
  }

  function writeConfig(profile = "standard"): void {
    writeFileSync(
      join(directory, ".opencode-dev-framework.yml"),
      `profile: ${profile}\ncommands:\n  lint: "touch ${markerPath()}"\n`,
    );
  }

  function createMockCtx() {
    const sessionHooks = new Map<string, (event: never) => Promise<void> | void>();
    const toolHooks = new Map<string, (event: never) => Promise<void> | void>();
    const addedTools = new Map<
      string,
      { execute: (input: unknown) => Promise<{ content: string }> }
    >();
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
          callback({
            add: (t: { name: string; execute: (input: unknown) => Promise<{ content: string }> }) =>
              addedTools.set(t.name, t),
          });
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
    return { ctx, sessionHooks, toolHooks, addedTools, disposers };
  }

  async function setup(profile = "standard") {
    writeConfig(profile);
    const mocks = createMockCtx();
    const mod = plugin as unknown as { setup: (c: unknown) => Promise<unknown> };
    cleanup = (await mod.setup(mocks.ctx)) as () => Promise<void> | void;
    const after = mocks.toolHooks.get("execute.after");
    expect(after).toBeDefined();
    return { ...mocks, afterHook: after as (event: unknown) => Promise<void> };
  }

  async function statusContent(
    addedTools: Map<string, { execute: (input: unknown) => Promise<{ content: string }> }>,
  ): Promise<string> {
    const tool = addedTools.get("dev_framework_status");
    expect(tool).toBeDefined();
    if (tool === undefined) throw new Error("dev_framework_status tool not registered");
    const result = await tool.execute({ directory });
    return result.content;
  }

  beforeEach(() => {
    clearConfigCache();
    directory = mkdtempSync(join(tmpdir(), "df-lint-after-"));
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

  it("edit→lint: completed edit tracks the file and runs the linter", async () => {
    const { afterHook, addedTools } = await setup();
    await afterHook({
      tool: "edit",
      sessionID: "lint-after-s1",
      agent: "build",
      messageID: "m1",
      id: "call-1",
      input: { filePath: "src/a.ts" },
      status: "completed",
      result: { data: {}, metadata: {} },
    });
    // Linter ran (marker written by the `touch` lint command).
    expect(existsSync(markerPath())).toBe(true);
    // File tracked for the gate.
    expect(await statusContent(addedTools)).toContain("src/a.ts");
  });

  it("read→skip: read-only tools neither track nor lint", async () => {
    const { afterHook, addedTools } = await setup();
    await afterHook({
      tool: "read",
      sessionID: "lint-after-s2",
      agent: "build",
      messageID: "m1",
      id: "call-1",
      input: { path: "src/a.ts" },
      status: "completed",
      result: { data: {}, metadata: {} },
    });
    expect(existsSync(markerPath())).toBe(false);
    expect(await statusContent(addedTools)).not.toContain("src/a.ts");
  });

  it("error→track-only: failed edits track without linting", async () => {
    const { afterHook, addedTools } = await setup();
    await afterHook({
      tool: "edit",
      sessionID: "lint-after-s3",
      agent: "build",
      messageID: "m1",
      id: "call-1",
      input: { filePath: "src/b.ts" },
      status: "error",
      error: { message: "boom", data: {} },
    });
    expect(existsSync(markerPath())).toBe(false);
    expect(await statusContent(addedTools)).toContain("src/b.ts");
  });

  it("off profile is a no-op (no track, no lint)", async () => {
    const { afterHook, addedTools } = await setup("off");
    await afterHook({
      tool: "edit",
      sessionID: "lint-after-s4",
      agent: "build",
      messageID: "m1",
      id: "call-1",
      input: { filePath: "src/c.ts" },
      status: "completed",
      result: { data: {}, metadata: {} },
    });
    expect(existsSync(markerPath())).toBe(false);
    expect(await statusContent(addedTools)).not.toContain("src/c.ts");
  });

  it("stale hook after teardown is a no-op (no double-lint)", async () => {
    const { afterHook } = await setup();
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
    await expect(
      afterHook({
        tool: "edit",
        sessionID: "lint-after-s5",
        agent: "build",
        messageID: "m1",
        id: "call-1",
        input: { filePath: "src/d.ts" },
        status: "completed",
        result: { data: {}, metadata: {} },
      }),
    ).resolves.toBeUndefined();
    expect(existsSync(markerPath())).toBe(false);
  });

  it("skips events with no extractable file path", async () => {
    const { afterHook, addedTools } = await setup();
    await afterHook({
      tool: "bash",
      sessionID: "lint-after-s6",
      agent: "build",
      messageID: "m1",
      id: "call-1",
      input: { command: "echo hi" },
      status: "completed",
      result: { data: {}, metadata: {} },
    });
    expect(existsSync(markerPath())).toBe(false);
    expect(await statusContent(addedTools)).toContain("Changed files tracked: 0");
  });
});
