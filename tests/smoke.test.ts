import { describe, expect, it } from "vitest";
import plugin from "../src/index";

describe("plugin entry point (V2)", () => {
  it("exports a V2 plugin with id and setup", () => {
    const p = plugin as unknown as { id: string; setup: unknown };
    expect(typeof p).toBe("object");
    expect(p.id).toBe("opencode-dev-framework");
    expect(typeof p.setup).toBe("function");
  });

  it("setup is async and returns a cleanup function", async () => {
    const ctx: Record<string, unknown> = {
      location: { directory: "/tmp" },
      session: { hook: async () => {} },
      tool: { hook: async () => {}, transform: async () => {} },
      event: { subscribe: () => ({ [Symbol.asyncIterator]: async function* () {} }) },
      app: { version: "2.0.0" },
    };
    const mod = plugin as unknown as { setup: (c: unknown) => Promise<unknown> };
    const result = await mod.setup(ctx);
    expect(result === undefined || typeof result === "function").toBe(true);
  });
});
