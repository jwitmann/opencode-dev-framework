import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import devFramework, { devFramework as namedDevFramework } from "../src/index";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "odf-smoke-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function stubCtx(directory: string) {
  const logged: { level: string; message: string }[] = [];
  const ctx = {
    directory,
    client: {
      app: {
        log: async (options: { body: { level: string; message: string } }) => {
          logged.push(options.body);
        },
      },
    },
  };
  return { ctx: ctx as never, logged };
}

describe("plugin entry point", () => {
  it("exports the plugin as default and named export", () => {
    expect(typeof devFramework).toBe("function");
    expect(devFramework).toBe(namedDevFramework);
  });

  it("registers no hooks when no config exists (off profile)", async () => {
    const { ctx } = stubCtx(dir);
    const hooks = await devFramework(ctx);
    expect(hooks).toEqual({});
  });

  it("registers the guardrail hook when configured", async () => {
    writeFileSync(join(dir, ".opencode-dev-framework.yml"), "profile: standard\n");
    const { ctx } = stubCtx(dir);
    const hooks = await devFramework(ctx);
    expect(typeof hooks["tool.execute.before"]).toBe("function");
  });

  it("throws on protected edits and logs an error", async () => {
    writeFileSync(
      join(dir, ".opencode-dev-framework.yml"),
      "profile: strict\nprotect:\n  - .env*\n",
    );
    const { ctx, logged } = stubCtx(dir);
    const hooks = await devFramework(ctx);
    const guardHook = hooks["tool.execute.before"];
    await expect(
      guardHook?.({ tool: "edit", sessionID: "s1", callID: "c1" }, { args: { filePath: ".env" } }),
    ).rejects.toThrow(/protected path/);
    expect(logged.some((entry) => entry.level === "error")).toBe(true);
  });

  it("warns without throwing in advisory profile", async () => {
    writeFileSync(
      join(dir, ".opencode-dev-framework.yml"),
      "profile: advisory\nprotect:\n  - .env*\n",
    );
    const { ctx, logged } = stubCtx(dir);
    const hooks = await devFramework(ctx);
    const guardHook = hooks["tool.execute.before"];
    await guardHook?.(
      { tool: "edit", sessionID: "s1", callID: "c1" },
      { args: { filePath: ".env" } },
    );
    expect(logged.some((entry) => entry.level === "warn")).toBe(true);
  });
});
