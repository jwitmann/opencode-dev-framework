import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginInput } from "@opencode-ai/plugin";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHooks } from "../src/index";
import { resolveConfig } from "../src/config";
import { getHookState } from "../src/registry";
import type { LogFn } from "../src/logger";
import type { SendMessageFn } from "../src/messenger";

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

function makePartsOutput(): { parts: { type: string; text: string; ignored?: boolean }[] } {
  return { parts: [] };
}

function buildWithMessenger(
  raw = {},
  extra?: Partial<{ run: Parameters<typeof buildHooks>[4]; sendMessage: SendMessageFn }>,
): {
  hooks: ReturnType<typeof buildHooks>;
  messages: { sessionID: string; text: string }[];
  output: { parts: { type: string; text: string }[] };
} {
  const messages: { sessionID: string; text: string }[] = [];
  const sendMessage: SendMessageFn = async (sessionID, text) => {
    messages.push({ sessionID, text });
  };
  const hooks = buildHooks(
    makeCtx(dir),
    makeConfig(raw),
    noopLog,
    extra?.run,
    undefined,
    undefined,
    sendMessage,
  );
  return { hooks, messages, output: makePartsOutput() };
}

describe("config hook", () => {
  it("registers df-status, df-profile, df-verify, and df-help slash commands", async () => {
    const hooks = buildHooks(makeCtx(dir), makeConfig(), noopLog);
    const config: { command?: Record<string, { template?: string; description?: string }> } = {};
    await hooks.config?.(config as never);
    expect(config.command?.["df-status"]).toBeDefined();
    expect(config.command?.["df-profile"]).toBeDefined();
    expect(config.command?.["df-verify"]).toBeDefined();
    expect(config.command?.["df-help"]).toBeDefined();
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
    const { hooks, messages, output } = buildWithMessenger();
    await hooks["command.execute.before"]?.(
      { command: "df-status", sessionID: "s1", arguments: "" },
      output as never,
    );
    expect(output.parts).toHaveLength(0);
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toContain("Profile: standard");
    expect(messages[0].text).toContain("Changed files tracked: 0");
  });

  it("df-profile changes the profile in config and state", async () => {
    const { hooks, messages, output } = buildWithMessenger();
    await hooks["command.execute.before"]?.(
      { command: "df-profile", sessionID: "s1", arguments: "strict" },
      output as never,
    );
    expect(output.parts).toHaveLength(0);
    expect(messages[0].text).toContain('profile set to "strict"');
    expect(getHookState(dir)?.config.profile).toBe("strict");
  });

  it("df-profile rejects invalid profiles", async () => {
    const { hooks, messages, output } = buildWithMessenger();
    await hooks["command.execute.before"]?.(
      { command: "df-profile", sessionID: "s1", arguments: "nope" },
      output as never,
    );
    expect(messages[0].text).toContain("Invalid profile");
    expect(getHookState(dir)?.config.profile).toBe("standard");
  });

  it("df-verify runs the completion gate and reports the result", async () => {
    const run = async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
    const { hooks, messages, output } = buildWithMessenger(
      { commands: { test: "echo ok" } },
      { run },
    );
    await hooks["command.execute.before"]?.(
      { command: "df-verify", sessionID: "s1", arguments: "" },
      output as never,
    );
    expect(output.parts).toHaveLength(0);
    expect(messages[0].text).toContain("completion gate");
  });

  it("df-help returns the command list", async () => {
    const { hooks, messages, output } = buildWithMessenger();
    await hooks["command.execute.before"]?.(
      { command: "df-help", sessionID: "s1", arguments: "" },
      output as never,
    );
    expect(output.parts).toHaveLength(0);
    expect(messages[0].text).toContain("/df-status");
    expect(messages[0].text).toContain("/df-profile");
    expect(messages[0].text).toContain("/df-verify");
  });

  it("unknown df-* command returns a helpful message", async () => {
    const { hooks, messages, output } = buildWithMessenger();
    await hooks["command.execute.before"]?.(
      { command: "df-foobar", sessionID: "s1", arguments: "" },
      output as never,
    );
    expect(output.parts).toHaveLength(0);
    expect(messages[0].text).toContain("Unknown command");
    expect(messages[0].text).toContain("/df-help");
  });

  it("falls back to output.parts when no messenger is available", async () => {
    const hooks = buildHooks(
      makeCtx(dir),
      makeConfig(),
      noopLog,
      undefined,
      undefined,
      undefined,
      null,
    );
    const output = makePartsOutput();
    await hooks["command.execute.before"]?.(
      { command: "df-help", sessionID: "s1", arguments: "" },
      output as never,
    );
    expect(output.parts).toHaveLength(1);
    expect(output.parts[0].text).toContain("/df-status");
    expect(output.parts[0].ignored).toBe(true);
  });
});
