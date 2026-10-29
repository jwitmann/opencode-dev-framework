import { describe, expect, it } from "vitest";
import tuiModule from "../tui.tsx";

describe("TUI plugin module", () => {
  it("exports a V2 plugin with id opencode-dev-framework", () => {
    const mod = tuiModule as unknown as { id: string; setup: unknown };
    expect(mod.id).toBe("opencode-dev-framework");
    expect(typeof mod.setup).toBe("function");
  });

  it("registers all four /df-* commands via keymap.layer with slash name", async () => {
    const layers: Array<{
      commands?: Array<{ id: string; slash?: { name: string }; run: unknown }>;
    }> = [];
    const ctx: Record<string, unknown> = {
      location: { directory: "/project" },
      data: { location: { default: () => ({ directory: "/project" }) } },
      keymap: {
        layer: (fn: () => { commands: unknown[] }) => {
          layers.push(fn() as never);
        },
      },
      ui: {
        dialog: {
          alert: async () => {},
          select: async () => undefined,
          show: () => {},
          clear: () => {},
        },
        toast: { show: () => {} },
      },
    };
    const mod = tuiModule as unknown as { setup: (c: unknown) => Promise<void> };
    await mod.setup(ctx);
    expect(layers).toHaveLength(1);
    const commands = layers[0].commands ?? [];
    expect(commands).toHaveLength(5);
    const ids = commands.map((c) => c.id).sort();
    expect(ids).toEqual(["df-help", "df-profile", "df-runtime", "df-status", "df-verify"]);
    for (const c of commands) {
      expect(c.slash?.name).toBe(c.id);
      expect(c.run).toBeTypeOf("function");
    }
  });

  it("opens a status dialog when /df-status runs", async () => {
    let alertCalled = false;
    let alertOptions: { title: string; message: string } | undefined;
    let setOptions: { size?: string; centered?: boolean } | undefined;
    const layers: Array<{ commands?: Array<{ id: string; run: unknown }> }> = [];
    const ctx: Record<string, unknown> = {
      location: { directory: "/project" },
      data: { location: { default: () => ({ directory: "/project" }) } },
      keymap: {
        layer: (fn: () => { commands: unknown[] }) => {
          layers.push(fn() as never);
        },
      },
      ui: {
        dialog: {
          alert: async (opts: { title: string; message: string }) => {
            alertCalled = true;
            alertOptions = opts;
          },
          set: (opts: { size?: string; centered?: boolean }) => {
            setOptions = opts;
          },
          select: async () => undefined,
          show: () => {},
          clear: () => {},
        },
        toast: { show: () => {} },
      },
    };
    const mod = tuiModule as unknown as { setup: (c: unknown) => Promise<void> };
    await mod.setup(ctx);
    const cmd = layers[0].commands?.find((c) => c.id === "df-status") as
      | { run: () => unknown }
      | undefined;
    await cmd?.run();
    expect(alertCalled).toBe(true);
    // The dialog title carries the heading; the message must not repeat it.
    expect(alertOptions?.title).toBe("opencode-dev-framework status");
    expect(alertOptions?.message.split("\n")[0]).not.toBe("opencode-dev-framework status");
    // Long content gets the large centered presentation.
    expect(setOptions).toEqual({ size: "large", centered: true });
  });

  it("opens a runtime dialog with snapshot version and hook method", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { writeRuntimeStatus } = await import("../src/runtime-status");
    const dir = mkdtempSync(join(tmpdir(), "df-tui-runtime-"));
    try {
      await writeRuntimeStatus(dir, { idleHookVia: "experimental.idle", continuation: "armed" });
      let alertMessage = "";
      let setCalled = false;
      const layers: Array<{ commands?: Array<{ id: string; run: unknown }> }> = [];
      const ctx: Record<string, unknown> = {
        location: { directory: dir },
        data: { location: { default: () => ({ directory: dir }) } },
        keymap: {
          layer: (fn: () => { commands: unknown[] }) => {
            layers.push(fn() as never);
          },
        },
        ui: {
          dialog: {
            alert: async (opts: { message: string }) => {
              alertMessage = opts.message;
            },
            set: () => {
              setCalled = true;
            },
            select: async () => undefined,
            show: () => {},
            clear: () => {},
          },
          toast: { show: () => {} },
        },
      };
      const mod = tuiModule as unknown as { setup: (c: unknown) => Promise<void> };
      await mod.setup(ctx);
      const cmd = layers[0].commands?.find((c) => c.id === "df-runtime") as
        | { run: () => unknown }
        | undefined;
      await cmd?.run();
      expect(alertMessage).toContain("registered via experimental.idle");
      expect(alertMessage).toMatch(/v\d+\.\d+\.\d+/);
      expect(setCalled).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("opens a profile picker when /df-profile runs without an argument", async () => {
    let selectCalled = false;
    const layers: Array<{ commands?: Array<{ id: string; run: unknown }> }> = [];
    const ctx: Record<string, unknown> = {
      location: { directory: "/project" },
      data: { location: { default: () => ({ directory: "/project" }) } },
      keymap: {
        layer: (fn: () => { commands: unknown[] }) => {
          layers.push(fn() as never);
        },
      },
      ui: {
        dialog: {
          alert: async () => {},
          select: async () => {
            selectCalled = true;
            return undefined;
          },
          show: () => {},
          clear: () => {},
        },
        toast: { show: () => {} },
      },
    };
    const mod = tuiModule as unknown as { setup: (c: unknown) => Promise<void> };
    await mod.setup(ctx);
    const cmd = layers[0].commands?.find((c) => c.id === "df-profile") as
      | { run: (i?: string) => unknown }
      | undefined;
    await cmd?.run("");
    expect(selectCalled).toBe(true);
  });

  it("handles /df-profile with invalid argument via toast without dialog", async () => {
    let selectCalled = false;
    let toastMessage = "";
    const layers: Array<{ commands?: Array<{ id: string; run: unknown }> }> = [];
    const ctx: Record<string, unknown> = {
      location: { directory: "/project" },
      data: { location: { default: () => ({ directory: "/project" }) } },
      keymap: {
        layer: (fn: () => { commands: unknown[] }) => {
          layers.push(fn() as never);
        },
      },
      ui: {
        dialog: {
          alert: async () => {},
          select: async () => {
            selectCalled = true;
            return undefined;
          },
          show: () => {},
          clear: () => {},
        },
        toast: {
          show: (opts: { message: string }) => {
            toastMessage = opts.message;
          },
        },
      },
    };
    const mod = tuiModule as unknown as { setup: (c: unknown) => Promise<void> };
    await mod.setup(ctx);
    const cmd = layers[0].commands?.find((c) => c.id === "df-profile") as
      | { run: (i?: string) => unknown }
      | undefined;
    await cmd?.run("invalid-profile");
    expect(toastMessage).toContain("Usage");
    expect(selectCalled).toBe(false);
  });
});
