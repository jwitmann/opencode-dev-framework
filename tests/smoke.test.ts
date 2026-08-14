import { describe, expect, it } from "vitest";
import devFramework, { devFramework as namedDevFramework } from "../src/index";

describe("plugin entry point (scaffold)", () => {
  it("exports the plugin as default and named export", () => {
    expect(typeof devFramework).toBe("function");
    expect(devFramework).toBe(namedDevFramework);
  });

  it("returns an empty hook map for now", async () => {
    const hooks = await devFramework({} as never);
    expect(hooks).toEqual({});
  });
});
