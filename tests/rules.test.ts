import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHooks } from "../src/index";
import type { LogFn } from "../src/logger";
import {
  BUNDLED_CONSTITUTION_DIR,
  BUNDLED_CONSTITUTION_PATH,
  injectConstitution,
  loadConstitution,
} from "../src/rules";
import type { Config, ResolvedConfig } from "../src/types";
import { resolveConfig } from "../src/config";

const CONFIG_PATH = "/project/.opencode-dev-framework.yml";

function resolve(raw: Config): ResolvedConfig {
  return resolveConfig(raw, CONFIG_PATH);
}

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "odf-rules-"));
}

describe("bundled constitution", () => {
  it("loads all numbered rule files from the bundled rules directory", async () => {
    const result = await loadConstitution(resolve({ profile: "standard" }));
    expect(result.source).toBe("bundled");
    expect(result.constitution).toContain("Activation Gate");
    expect(result.constitution).toContain("Quality Bar");
    expect(result.constitution).toContain("Match Existing Patterns");
    expect(result.constitution).toContain("Testing Discipline");
    expect(result.constitution).toContain("Delegation");
    expect(BUNDLED_CONSTITUTION_PATH).toMatch(/rules\/constitution\.md$/);
    expect(BUNDLED_CONSTITUTION_DIR).toMatch(/rules$/);
  });
});

describe("loadConstitution", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns null for the off profile without reading anything", async () => {
    const result = await loadConstitution(resolve({ profile: "off" }), dir);
    expect(result.constitution).toBeNull();
    expect(result.source).toBeNull();
    expect(result.warning).toBeUndefined();
  });

  it("loads the bundled constitution when none is configured", async () => {
    const result = await loadConstitution(resolve({ profile: "standard" }), dir);
    expect(result.source).toBe("bundled");
    expect(result.constitution).toBeTruthy();
    expect(result.warning).toBeUndefined();
  });

  it("loads a configured custom constitution (relative path)", async () => {
    await writeFile(join(dir, "TEAM.md"), "# Team Rules\nDo the thing.");
    const result = await loadConstitution(
      resolve({ profile: "standard", constitution: "TEAM.md" }),
      dir,
    );
    expect(result.source).toBe("custom");
    expect(result.constitution).toContain("Team Rules");
  });

  it("loads a configured custom constitution (absolute path)", async () => {
    const customPath = join(dir, "abs.md");
    await writeFile(customPath, "absolute rules");
    const result = await loadConstitution(
      resolve({ profile: "standard", constitution: customPath }),
      dir,
    );
    expect(result.source).toBe("custom");
    expect(result.constitution).toBe("absolute rules");
  });

  it("falls back to the bundled constitution with a warning when the custom file is missing", async () => {
    const result = await loadConstitution(
      resolve({ profile: "standard", constitution: "does-not-exist.md" }),
      dir,
    );
    expect(result.source).toBe("bundled");
    expect(result.constitution).toBeTruthy();
    expect(result.warning).toContain("does-not-exist.md");
  });

  it("falls back with a warning when the custom file is empty", async () => {
    await writeFile(join(dir, "empty.md"), "   \n");
    const result = await loadConstitution(
      resolve({ profile: "standard", constitution: "empty.md" }),
      dir,
    );
    expect(result.source).toBe("bundled");
    expect(result.warning).toContain("empty.md");
  });

  it("appends configured rules files to the bundled constitution", async () => {
    await writeFile(join(dir, "TEAM.md"), "# Team Rules\nDo the thing.");
    const result = await loadConstitution(
      resolve({ profile: "standard", rules: ["TEAM.md"] }),
      dir,
    );
    expect(result.source).toBe("bundled");
    expect(result.constitution).toContain("Quality Bar");
    expect(result.constitution).toContain("Team Rules");
    expect(result.constitution?.indexOf("Quality Bar")).toBeLessThan(
      result.constitution?.indexOf("Team Rules") ?? 0,
    );
  });

  it("appends configured rules files to a custom constitution", async () => {
    await writeFile(join(dir, "TEAM.md"), "# Team Rules");
    await writeFile(join(dir, "EXTRA.md"), "# Extra Rules");
    const result = await loadConstitution(
      resolve({ profile: "standard", constitution: "TEAM.md", rules: ["EXTRA.md"] }),
      dir,
    );
    expect(result.source).toBe("custom");
    expect(result.constitution).toContain("Team Rules");
    expect(result.constitution).toContain("Extra Rules");
  });

  it("warns and skips missing rules files", async () => {
    const result = await loadConstitution(
      resolve({ profile: "standard", rules: ["missing.md"] }),
      dir,
    );
    expect(result.source).toBe("bundled");
    expect(result.warning).toContain("missing.md");
    expect(result.constitution).toBeTruthy();
  });
});

describe("injectConstitution", () => {
  it("appends the constitution to the system prompt", () => {
    expect(injectConstitution(["You are helpful."], "RULES")).toEqual([
      "You are helpful.",
      "RULES",
    ]);
  });

  it("returns the array unchanged when constitution is null", () => {
    const system = ["You are helpful."];
    expect(injectConstitution(system, null)).toBe(system);
  });

  it("does not inject twice when already present", () => {
    const system = ["header", "RULES"];
    expect(injectConstitution(system, "RULES")).toBe(system);
  });

  it("does not inject when an existing entry already contains the text", () => {
    const system = ["header\nRULES\nfooter"];
    expect(injectConstitution(system, "RULES")).toBe(system);
  });
});

describe("system.transform wiring", () => {
  type SystemTransform = NonNullable<Hooks["experimental.chat.system.transform"]>;
  type Input = Parameters<SystemTransform>[0];
  type Output = Parameters<SystemTransform>[1];

  const stubCtx = { directory: "/project" } as PluginInput;

  function makeInput(): Input {
    return {} as Input;
  }

  async function runTransform(
    constitution: string | null,
    system: string[],
  ): Promise<{ system: string[]; messages: string[] }> {
    const messages: string[] = [];
    const log: LogFn = async (_level, message) => {
      messages.push(message);
    };
    const hooks = buildHooks(
      stubCtx,
      resolve({ profile: "standard" }),
      log,
      undefined,
      undefined,
      constitution,
    );
    const transform = hooks["experimental.chat.system.transform"];
    expect(transform).toBeDefined();
    const output: Output = { system };
    await transform?.(makeInput(), output);
    return { system: output.system, messages };
  }

  it("injects the constitution into the system prompt", async () => {
    const { system, messages } = await runTransform("RULES", ["base prompt"]);
    expect(system).toEqual(["base prompt", "RULES"]);
    expect(messages).toEqual(["constitution injected into system prompt"]);
  });

  it("leaves the system prompt untouched when constitution is null", async () => {
    const { system, messages } = await runTransform(null, ["base prompt"]);
    expect(system).toEqual(["base prompt"]);
    expect(messages).toEqual([]);
  });

  it("does not inject twice into the same system prompt", async () => {
    const { system, messages } = await runTransform("RULES", ["base", "RULES"]);
    expect(system).toEqual(["base", "RULES"]);
    expect(messages).toEqual([]);
  });
});
