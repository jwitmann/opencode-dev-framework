import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHooks } from "../src/index";
import type { LogFn } from "../src/logger";
import {
  BUNDLED_CONSTITUTION_DIR,
  injectConstitution,
  loadConstitution,
  LOCAL_RULES_DIR,
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

  it("replaces the bundled constitution with explicit rules files", async () => {
    await writeFile(join(dir, "TEAM.md"), "# Team Rules\nDo the thing.");
    const result = await loadConstitution(
      resolve({ profile: "standard", rules: ["TEAM.md"] }),
      dir,
    );
    expect(result.source).toBe("custom");
    expect(result.constitution).toContain("Team Rules");
    expect(result.constitution).not.toContain("Quality Bar");
  });

  it("appends explicit rules files to the bundled constitution when mode is append", async () => {
    await writeFile(join(dir, "TEAM.md"), "# Team Rules\nDo the thing.");
    const result = await loadConstitution(
      resolve({ profile: "standard", rules: { mode: "append", files: ["TEAM.md"] } }),
      dir,
    );
    expect(result.source).toBe("bundled");
    expect(result.constitution).toContain("Quality Bar");
    expect(result.constitution).toContain("Team Rules");
    expect(result.constitution?.indexOf("Quality Bar")).toBeLessThan(
      result.constitution?.indexOf("Team Rules") ?? 0,
    );
  });

  it("discovers local .opencode/opencode-dev-framework/rules/*.md overrides", async () => {
    const localDir = join(dir, LOCAL_RULES_DIR);
    await mkdir(localDir, { recursive: true });
    await writeFile(join(localDir, "99-local.md"), "# Local Rule");
    const result = await loadConstitution(resolve({ profile: "standard" }), dir);
    expect(result.source).toBe("custom");
    expect(result.constitution).toContain("Local Rule");
    expect(result.constitution).not.toContain("Quality Bar");
  });

  it("falls back to bundled rules when the local override directory is empty", async () => {
    await mkdir(join(dir, LOCAL_RULES_DIR), { recursive: true });
    const result = await loadConstitution(resolve({ profile: "standard" }), dir);
    expect(result.source).toBe("bundled");
    expect(result.constitution).toContain("Quality Bar");
  });

  it("warns and skips missing explicit rules files", async () => {
    const result = await loadConstitution(
      resolve({ profile: "standard", rules: ["missing.md"] }),
      dir,
    );
    expect(result.source).toBeNull();
    expect(result.constitution).toBeNull();
    expect(result.warning).toContain("missing.md");
  });

  it("injects the configured style guide", async () => {
    await writeFile(join(dir, "STYLE.md"), "Use 2 spaces.");
    const result = await loadConstitution(
      resolve({ profile: "standard", style_guide: "STYLE.md" }),
      dir,
    );
    expect(result.constitution).toContain("Quality Bar");
    expect(result.constitution).toContain("Style Guide");
    expect(result.constitution).toContain("Use 2 spaces.");
  });

  it("warns when the configured style guide is missing", async () => {
    const result = await loadConstitution(
      resolve({ profile: "standard", style_guide: "missing.md" }),
      dir,
    );
    expect(result.warning).toContain("missing.md");
    expect(result.constitution).toContain("Quality Bar");
  });

  it("auto-discovers a style guide file when style_guide is not configured", async () => {
    await writeFile(join(dir, "CONTRIBUTING.md"), "# Contributing\nBe kind.");
    const result = await loadConstitution(resolve({ profile: "standard" }), dir);
    expect(result.constitution).toContain("# Style Guide");
    expect(result.constitution).toContain("Be kind.");
  });

  it("auto-discovers docs/STYLE.md before CONTRIBUTING.md", async () => {
    await writeFile(join(dir, "CONTRIBUTING.md"), "# Contributing");
    await mkdir(join(dir, "docs"), { recursive: true });
    await writeFile(join(dir, "docs", "STYLE.md"), "# Docs Style");
    const result = await loadConstitution(resolve({ profile: "standard" }), dir);
    expect(result.constitution).toContain("Docs Style");
    expect(result.constitution).not.toContain("Contributing");
  });

  it("uses explicit style_guide over auto-discovery", async () => {
    await writeFile(join(dir, "CONTRIBUTING.md"), "# Contributing");
    await writeFile(join(dir, "TEAM.md"), "# Team");
    const result = await loadConstitution(
      resolve({ profile: "standard", style_guide: "TEAM.md" }),
      dir,
    );
    expect(result.constitution).toContain("# Team");
    expect(result.constitution).not.toContain("Contributing");
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
