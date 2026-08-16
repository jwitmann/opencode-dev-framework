import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginInput } from "@opencode-ai/plugin";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHooks } from "../src/index";
import type { LogFn } from "../src/logger";
import { getHookState } from "../src/registry";
import { resolveConfig } from "../src/config";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "odf-tools-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeCtx(directory: string): PluginInput {
  return { directory } as PluginInput;
}

const noopLog: LogFn = async () => {};

function resolveStandardConfig(raw = {}) {
  return resolveConfig({ profile: "standard", ...raw }, join(dir, ".opencode-dev-framework.yml"));
}

describe("dev_framework_init tool", () => {
  it("scaffolds templates into the project directory", async () => {
    const hooks = buildHooks(makeCtx(dir), { profile: "standard" } as never, noopLog);
    const init = hooks.tool?.dev_framework_init;
    expect(init).toBeDefined();
    const result = await init?.execute({}, { directory: dir } as never);
    expect(typeof result).toBe("string");
    expect(result).toContain("Installed opencode-dev-framework templates");
    expect(result).toContain("Config: created");
  });
});

describe("dev_framework_set_profile tool", () => {
  it("creates the config file and applies the profile immediately", async () => {
    const hooks = buildHooks(makeCtx(dir), { profile: "standard" } as never, noopLog);
    const setProfile = hooks.tool?.dev_framework_set_profile;
    expect(setProfile).toBeDefined();

    const result = await setProfile?.execute({ profile: "strict" }, { directory: dir } as never);
    expect(typeof result).toBe("string");
    expect(result).toContain('profile set to "strict"');

    const state = getHookState(dir);
    expect(state?.config.profile).toBe("strict");
  });

  it("rejects invalid profiles", async () => {
    const hooks = buildHooks(makeCtx(dir), { profile: "standard" } as never, noopLog);
    const setProfile = hooks.tool?.dev_framework_set_profile;
    const result = await setProfile?.execute({ profile: "invalid" }, { directory: dir } as never);
    expect(result).toContain("Invalid profile");
  });

  it("preserves comments and other keys when editing the profile", async () => {
    const { writeFile, readFile } = await import("node:fs/promises");
    const configPath = join(dir, ".opencode-dev-framework.yml");
    await writeFile(
      configPath,
      [
        "# project quality config",
        "profile: standard",
        "",
        "# never block lint",
        "protect_mode: warn",
        "",
      ].join("\n"),
      "utf8",
    );
    const hooks = buildHooks(makeCtx(dir), { profile: "standard" } as never, noopLog);
    const setProfile = hooks.tool?.dev_framework_set_profile;

    const result = await setProfile?.execute({ profile: "strict" }, { directory: dir } as never);
    expect(result).toContain('profile set to "strict"');

    const content = await readFile(configPath, "utf8");
    expect(content).toContain("# project quality config");
    expect(content).toContain("# never block lint");
    expect(content).toContain("protect_mode: warn");
    expect(content).toContain("profile: strict");
    expect(content).not.toContain("profile: standard");
  });
});

describe("dev_framework_status tool", () => {
  it("reports the configured profile and gate settings", async () => {
    const config = resolveStandardConfig();
    const hooks = buildHooks(makeCtx(dir), config, noopLog);
    const status = hooks.tool?.dev_framework_status;
    expect(status).toBeDefined();

    const result = await status?.execute({}, { directory: dir } as never);
    expect(typeof result).toBe("string");
    expect(result).toContain("Profile: standard");
    expect(result).toContain("run_typecheck: true");
    expect(result).toContain("max_blocks: 3");
    expect(result).toContain("precommit: off");
  });

  it("reports tracked changed files", async () => {
    const config = resolveStandardConfig();
    const hooks = buildHooks(makeCtx(dir), config, noopLog);
    const state = getHookState(dir);
    state?.tracker.add(join(dir, "src", "foo.go"), dir);

    const status = hooks.tool?.dev_framework_status;
    const result = await status?.execute({}, { directory: dir } as never);
    expect(result).toContain("Changed files tracked: 1");
    expect(result).toContain("src/foo.go");
  });

  it("reports explicit rules configuration", async () => {
    const config = resolveStandardConfig({
      rules: { mode: "append", files: ["docs/extra.md"] },
    });
    const hooks = buildHooks(makeCtx(dir), config, noopLog);
    const status = hooks.tool?.dev_framework_status;
    const result = await status?.execute({}, { directory: dir } as never);
    expect(result).toContain("mode: append");
    expect(result).toContain("- docs/extra.md");
  });
});
