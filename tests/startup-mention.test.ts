import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache } from "../src/config";
import plugin from "../src/index";
import { installTemplates } from "../src/installer";
import { resetRegistry } from "../src/registry";

describe("startup template-drift mention (plan 20)", () => {
  let directory: string;

  beforeEach(() => {
    clearConfigCache();
    resetRegistry();
    directory = mkdtempSync(join(tmpdir(), "df-startup-"));
    writeFileSync(join(directory, ".opencode-dev-framework.yml"), "profile: standard\n");
  });

  afterEach(() => {
    clearConfigCache();
    resetRegistry();
    rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function createMockCtx() {
    const sessionHooks = new Map<string, (event: never) => Promise<void> | void>();
    const makeRegistration = () => ({ dispose: vi.fn(async () => {}) });
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
        hook: vi.fn(async () => makeRegistration()),
      },
      tool: {
        hook: vi.fn(async () => makeRegistration()),
        transform: vi.fn(async (callback: (editor: { add: (t: unknown) => void }) => void) => {
          callback({ add: () => {} });
          return makeRegistration();
        }),
      },
      command: {
        transform: vi.fn(async (callback: (editor: { add: (t: unknown) => void }) => void) => {
          callback({ add: () => {} });
          return makeRegistration();
        }),
        list: vi.fn(async () => []),
      },
      event: {
        subscribe: () => ({
          [Symbol.asyncIterator]: async function* () {},
        }),
      },
      app: { version: "2.0.18" },
    };
    return { ctx, sessionHooks };
  }

  async function contextHook() {
    const { ctx, sessionHooks } = createMockCtx();
    const mod = plugin as unknown as { setup: (c: unknown) => Promise<unknown> };
    await mod.setup(ctx);
    const hook = sessionHooks.get("context");
    expect(hook).toBeDefined();
    return hook as (event: unknown) => Promise<void>;
  }

  function mentionParts(system: { type: string; text: string }[]): string[] {
    return system.filter((p) => p.text.includes("/df-update")).map((p) => p.text);
  }

  it("mentions once on first sighting of a drifted tree", async () => {
    await installTemplates(directory, { skipExisting: true });
    // Drift it: remove all but one shipped file, so the rest read as add.
    const { listTemplateFiles } = await import("../src/installer");
    const all = await listTemplateFiles();
    const { rm } = await import("node:fs/promises");
    for (const name of all.slice(1)) {
      await rm(join(directory, name));
    }
    const hook = await contextHook();
    const system: { type: string; text: string }[] = [];
    await hook({ system, sessionID: "startup-s1" });
    const first = mentionParts(system);
    expect(first).toHaveLength(1);
    expect(first[0]).toContain("to add");

    // Second turn of the same session mentions nothing new.
    await hook({ system, sessionID: "startup-s1" });
    expect(mentionParts(system)).toHaveLength(1);
  });

  it("mentions again for a new session", async () => {
    await installTemplates(directory, { skipExisting: true });
    const { listTemplateFiles } = await import("../src/installer");
    const all = await listTemplateFiles();
    const { rm } = await import("node:fs/promises");
    for (const name of all.slice(1)) {
      await rm(join(directory, name));
    }
    const hook = await contextHook();
    const first: { type: string; text: string }[] = [];
    await hook({ system: first, sessionID: "startup-s2" });
    expect(mentionParts(first)).toHaveLength(1);
    const second: { type: string; text: string }[] = [];
    await hook({ system: second, sessionID: "startup-s3" });
    expect(mentionParts(second)).toHaveLength(1);
  });

  it("stays silent on a current tree", async () => {
    await installTemplates(directory, { skipExisting: true });
    const hook = await contextHook();
    const system: { type: string; text: string }[] = [];
    await hook({ system, sessionID: "startup-s4" });
    expect(mentionParts(system)).toHaveLength(0);
  });

  it("stays silent on an empty tree (no /df-init nag)", async () => {
    const hook = await contextHook();
    const system: { type: string; text: string }[] = [];
    await hook({ system, sessionID: "startup-s5" });
    expect(mentionParts(system)).toHaveLength(0);
  });
});
