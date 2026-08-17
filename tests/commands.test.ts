import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginInput } from "@opencode-ai/plugin";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHooks } from "../src/index";
import { resolveConfig } from "../src/config";
import { getHookState } from "../src/registry";
import { changeProfile, verifyGate } from "../src/commands";
import { clearConfigCache } from "../src/config";
import type { LogFn } from "../src/logger";
import type { RunCommand } from "../src/host";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "odf-commands-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const noopLog: LogFn = async () => {};

function makeCtx(directory: string): PluginInput {
  return { directory } as PluginInput;
}

function makeConfig(raw = {}) {
  return resolveConfig({ profile: "standard", ...raw }, join(dir, ".opencode-dev-framework.yml"));
}

describe("config hook", () => {
  it("does not register any df-* prompt commands (all four are TUI commands)", async () => {
    const hooks = buildHooks(makeCtx(dir), makeConfig(), noopLog);
    const config: { command?: Record<string, { template?: string; description?: string }> } = {};
    await hooks.config?.(config as never);
    // TUI commands (df-status, df-help, df-profile, df-verify) never insert text
    // into the chat stream, so they cannot leak into a model turn. Registering
    // them as server prompt commands would always produce a model turn, which
    // is exactly what we avoid. So the config hook registers none of them.
    expect(config.command?.["df-profile"]).toBeUndefined();
    expect(config.command?.["df-verify"]).toBeUndefined();
    expect(config.command?.["df-status"]).toBeUndefined();
    expect(config.command?.["df-help"]).toBeUndefined();
  });

  it("captures host permissions (OpenCode object shape) into hook state", async () => {
    const hooks = buildHooks(makeCtx(dir), makeConfig(), noopLog);
    const config = { permission: { edit: "deny", bash: "allow" } };
    await hooks.config?.(config as never);
    expect(getHookState(dir)?.hostPermissions).toEqual({ edit: "deny", bash: "allow" });
  });

  it("ignores non-object host permissions", async () => {
    const hooks = buildHooks(makeCtx(dir), makeConfig(), noopLog);
    const config = { permission: [{ permission: "edit", pattern: "**/*.md", action: "deny" }] };
    await hooks.config?.(config as never);
    expect(getHookState(dir)?.hostPermissions).toBeUndefined();
  });
});

describe("changeProfile helper", () => {
  it("edits the profile key in the config file", async () => {
    await writeFile(
      join(dir, ".opencode-dev-framework.yml"),
      "profile: standard\n\nprotect:\n  - .env\n",
    );
    clearConfigCache();
    const message = await changeProfile(dir, "strict");
    expect(message).toContain('profile set to "strict"');
    const content = await readFile(join(dir, ".opencode-dev-framework.yml"), "utf8");
    expect(content).toContain("profile: strict");
    // Original content preserved (text edit, not re-serialize).
    expect(content).toContain("protect:");
  });

  it("creates the config file when missing", async () => {
    const message = await changeProfile(dir, "advisory");
    expect(message).toContain('profile set to "advisory"');
    const content = await readFile(join(dir, ".opencode-dev-framework.yml"), "utf8");
    expect(content).toContain("profile: advisory");
  });
});

describe("verifyGate helper", () => {
  it("runs the gate and reports success", async () => {
    const config = resolveConfig(
      { profile: "standard", commands: { test: "echo ok" } },
      join(dir, ".opencode-dev-framework.yml"),
    );
    const run: RunCommand = async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
    const { report, summary } = await verifyGate(run, dir, config);
    expect(report.ok).toBe(true);
    expect(summary).toContain("completion gate");
  });

  it("reports failure when a command exits non-zero", async () => {
    const config = resolveConfig(
      { profile: "standard", commands: { test: "exit 1" }, gate: { skip_unchanged: false } },
      join(dir, ".opencode-dev-framework.yml"),
    );
    const run: RunCommand = async () => ({
      stdout: "",
      stderr: "boom",
      exitCode: 1,
      timedOut: false,
    });
    const { report } = await verifyGate(run, dir, config);
    expect(report.ok).toBe(false);
  });
});
