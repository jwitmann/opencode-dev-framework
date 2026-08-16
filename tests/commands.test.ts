import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginInput } from "@opencode-ai/plugin";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHooks } from "../src/index";
import { resolveConfig } from "../src/config";
import { getHookState } from "../src/registry";
import type { LogFn } from "../src/logger";

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

function makePartsOutput(): { parts: { type: string; text: string }[] } {
  return { parts: [] };
}

describe("config hook", () => {
  it("registers df-status, df-profile, and df-verify slash commands", async () => {
    const hooks = buildHooks(makeCtx(dir), makeConfig(), noopLog);
    const config: { command?: Record<string, { template?: string; description?: string }> } = {};
    await hooks.config?.(config as never);
    expect(config.command?.["df-status"]).toBeDefined();
    expect(config.command?.["df-profile"]).toBeDefined();
    expect(config.command?.["df-verify"]).toBeDefined();
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

describe("command.execute.before hook", () => {
  it("df-status returns the current plugin state", async () => {
    const hooks = buildHooks(makeCtx(dir), makeConfig(), noopLog);
    const output = makePartsOutput();
    await hooks["command.execute.before"]?.(
      { command: "df-status", sessionID: "s1", arguments: "" },
      output as never,
    );
    expect(output.parts).toHaveLength(1);
    expect(output.parts[0].text).toContain("Profile: standard");
    expect(output.parts[0].text).toContain("Changed files tracked: 0");
  });

  it("df-profile changes the profile in config and state", async () => {
    const hooks = buildHooks(makeCtx(dir), makeConfig(), noopLog);
    const output = makePartsOutput();
    await hooks["command.execute.before"]?.(
      { command: "df-profile", sessionID: "s1", arguments: "strict" },
      output as never,
    );
    expect(output.parts[0].text).toContain('profile set to "strict"');
    expect(getHookState(dir)?.config.profile).toBe("strict");
  });

  it("df-profile rejects invalid profiles", async () => {
    const hooks = buildHooks(makeCtx(dir), makeConfig(), noopLog);
    const output = makePartsOutput();
    await hooks["command.execute.before"]?.(
      { command: "df-profile", sessionID: "s1", arguments: "nope" },
      output as never,
    );
    expect(output.parts[0].text).toContain("Invalid profile");
    expect(getHookState(dir)?.config.profile).toBe("standard");
  });

  it("df-verify runs the completion gate and reports the result", async () => {
    const run = async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
    const config = makeConfig({ commands: { test: "echo ok" } });
    const hooks = buildHooks(makeCtx(dir), config, noopLog, run);
    const output = makePartsOutput();
    await hooks["command.execute.before"]?.(
      { command: "df-verify", sessionID: "s1", arguments: "" },
      output as never,
    );
    expect(output.parts).toHaveLength(1);
    expect(output.parts[0].text).toContain("completion gate");
  });

  it("df-help returns the command list", async () => {
    const hooks = buildHooks(makeCtx(dir), makeConfig(), noopLog);
    const output = makePartsOutput();
    await hooks["command.execute.before"]?.(
      { command: "df-help", sessionID: "s1", arguments: "" },
      output as never,
    );
    expect(output.parts[0].text).toContain("/df-status");
    expect(output.parts[0].text).toContain("/df-profile");
    expect(output.parts[0].text).toContain("/df-verify");
  });

  it("unknown df-* command returns a helpful message", async () => {
    const hooks = buildHooks(makeCtx(dir), makeConfig(), noopLog);
    const output = makePartsOutput();
    await hooks["command.execute.before"]?.(
      { command: "df-foobar", sessionID: "s1", arguments: "" },
      output as never,
    );
    expect(output.parts[0].text).toContain("Unknown command");
    expect(output.parts[0].text).toContain("/df-help");
  });
});
