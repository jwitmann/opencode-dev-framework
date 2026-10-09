import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache } from "../src/config";
import plugin from "../src/index";

describe("Phase 26.1: dev_framework_verify tool (server-side gate, reshaped ship)", () => {
  let directory: string;
  let cleanup: (() => Promise<void> | void) | undefined;

  function markerPath(): string {
    return join(directory, "gate-marker");
  }

  function writeConfig(body: string): void {
    writeFileSync(join(directory, ".opencode-dev-framework.yml"), body);
  }

  function gateConfig(): string {
    // Typecheck step writes the marker (proof the gate ran); tests off.
    return `profile: standard\ncommands:\n  typecheck: "touch ${markerPath()}"\ngate:\n  run_tests: false\n  lint_changed: false\n  skip_unchanged: false\n`;
  }

  function createMockCtx() {
    const addedTools = new Map<
      string,
      { execute: (input: unknown) => Promise<{ content: string }> }
    >();
    const ctx = {
      location: { directory },
      session: {
        hook: vi.fn(async () => ({ dispose: async () => {} })),
        prompt: vi.fn(),
        synthetic: vi.fn(),
      },
      permission: {
        hook: vi.fn(async () => ({ dispose: async () => {} })),
      },
      tool: {
        hook: vi.fn(async () => ({ dispose: async () => {} })),
        transform: vi.fn(async (callback: (editor: { add: (t: unknown) => void }) => void) => {
          callback({
            add: (t: { name: string; execute: (input: unknown) => Promise<{ content: string }> }) =>
              addedTools.set(t.name, t),
          });
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
    return { ctx, addedTools };
  }

  beforeEach(() => {
    clearConfigCache();
    directory = mkdtempSync(join(tmpdir(), "df-verify-tool-"));
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

  it("registers dev_framework_verify alongside the existing tools", async () => {
    writeConfig(gateConfig());
    const { ctx, addedTools } = createMockCtx();
    const mod = plugin as unknown as { setup: (c: unknown) => Promise<unknown> };
    cleanup = (await mod.setup(ctx)) as () => Promise<void> | void;
    expect(addedTools.has("dev_framework_init")).toBe(true);
    expect(addedTools.has("dev_framework_set_profile")).toBe(true);
    expect(addedTools.has("dev_framework_status")).toBe(true);
    expect(addedTools.has("dev_framework_verify")).toBe(true);
  });

  it("runs the gate and returns the summary (marker proof, no re-prompt)", async () => {
    writeConfig(gateConfig());
    const { ctx, addedTools } = createMockCtx();
    const mod = plugin as unknown as { setup: (c: unknown) => Promise<unknown> };
    cleanup = (await mod.setup(ctx)) as () => Promise<void> | void;
    const tool = addedTools.get("dev_framework_verify");
    expect(tool).toBeDefined();
    const result = await tool?.execute({ directory });
    // Gate ran (marker written by the typecheck step) and reported back.
    expect(existsSync(markerPath())).toBe(true);
    expect(result?.content).toContain("completion gate");
  });

  it("reports gate failure in content instead of throwing", async () => {
    writeConfig(
      'profile: standard\ncommands:\n  typecheck: "exit 3"\ngate:\n  run_tests: false\n  lint_changed: false\n  skip_unchanged: false\n',
    );
    const { ctx, addedTools } = createMockCtx();
    const mod = plugin as unknown as { setup: (c: unknown) => Promise<unknown> };
    cleanup = (await mod.setup(ctx)) as () => Promise<void> | void;
    const tool = addedTools.get("dev_framework_verify");
    const result = await tool?.execute({ directory });
    expect(result?.content).toContain("typecheck");
  });
});
