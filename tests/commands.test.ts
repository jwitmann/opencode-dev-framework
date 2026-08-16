import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginInput } from "@opencode-ai/plugin";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHooks } from "../src/index";
import { resolveConfig } from "../src/config";
import { getHookState, setSessionDirectory } from "../src/registry";
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

  it("captures host permissions into hook state", async () => {
    const hooks = buildHooks(makeCtx(dir), makeConfig(), noopLog);
    const config = { permission: [{ permission: "edit", pattern: "**/*.md", action: "deny" }] };
    await hooks.config?.(config as never);
    expect(getHookState(dir)?.hostPermissions).toEqual([
      { permission: "edit", pattern: "**/*.md", action: "deny" },
    ]);
  });
});

describe("command.execute.before hook (argument form)", () => {
  function setup(run?: RunCommand) {
    const toasts: { message: string; variant?: string }[] = [];
    const hooks = buildHooks(
      makeCtx(dir),
      makeConfig(),
      noopLog,
      run ??
        (async () => ({
          stdout: "",
          stderr: "",
          exitCode: 0,
          timedOut: false,
        })),
    );
    const state = getHookState(dir);
    if (state) {
      state.showToast = (message, variant) => toasts.push({ message, variant });
    }
    setSessionDirectory("s1", dir);
    return { hooks, toasts };
  }

  it("df-profile with a valid argument applies the profile and suppresses output (no leak)", async () => {
    const { hooks, toasts } = setup();
    await writeFile(join(dir, ".opencode-dev-framework.yml"), "profile: standard\n");
    clearConfigCache();
    const output: { parts: unknown[] } = {
      parts: [{ type: "text", text: "/df-profile standard" }],
    };
    await hooks["command.execute.before"]?.(
      { command: "df-profile", sessionID: "s1", arguments: "strict" } as never,
      output as never,
    );
    expect(toasts[0].message).toContain('profile set to "strict"');
    expect(toasts[0].variant).toBe("success");
    expect(output.parts).toHaveLength(0);
    const content = await readFile(join(dir, ".opencode-dev-framework.yml"), "utf8");
    expect(content).toContain("profile: strict");
  });

  it("df-profile with an invalid argument shows usage and suppresses output", async () => {
    const { hooks, toasts } = setup();
    await writeFile(join(dir, ".opencode-dev-framework.yml"), "profile: standard\n");
    clearConfigCache();
    const output: { parts: unknown[] } = { parts: [{ type: "text", text: "/df-profile bogus" }] };
    await hooks["command.execute.before"]?.(
      { command: "df-profile", sessionID: "s1", arguments: "bogus" } as never,
      output as never,
    );
    expect(toasts[0].message).toContain("Usage");
    expect(toasts[0].variant).toBe("warning");
    expect(output.parts).toHaveLength(0);
    const content = await readFile(join(dir, ".opencode-dev-framework.yml"), "utf8");
    expect(content).toContain("profile: standard");
  });

  it("bare df-profile (no argument) is left for the TUI picker — output is not suppressed", async () => {
    const { hooks } = setup();
    await writeFile(join(dir, ".opencode-dev-framework.yml"), "profile: standard\n");
    clearConfigCache();
    const output: { parts: unknown[] } = { parts: [{ type: "text", text: "/df-profile" }] };
    await hooks["command.execute.before"]?.(
      { command: "df-profile", sessionID: "s1", arguments: "" } as never,
      output as never,
    );
    // No argument → the bare form is handled by the TUI picker; the hook does
    // not suppress (the part is left intact for the TUI command to render).
    expect(output.parts).toHaveLength(1);
    const content = await readFile(join(dir, ".opencode-dev-framework.yml"), "utf8");
    expect(content).toContain("profile: standard");
  });

  it("df-verify runs the gate and suppresses output", async () => {
    const { hooks, toasts } = setup(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    }));
    const output: { parts: unknown[] } = { parts: [{ type: "text", text: "/df-verify" }] };
    await hooks["command.execute.before"]?.(
      { command: "df-verify", sessionID: "s1", arguments: "run" } as never,
      output as never,
    );
    expect(toasts[0].message).toContain("completion gate");
    expect(output.parts).toHaveLength(0);
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
