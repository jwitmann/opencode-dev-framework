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

type Toast = { message: string; variant?: string };

function buildWithToast(
  raw = {},
  extra?: Partial<{ run: Parameters<typeof buildHooks>[4] }>,
): {
  hooks: ReturnType<typeof buildHooks>;
  toasts: Toast[];
} {
  const toasts: Toast[] = [];
  const showToast = (message: string, variant?: "info" | "success" | "warning" | "error") => {
    toasts.push({ message, variant });
  };
  const ctx = makeCtx(dir);
  // Inject the toast capture by monkeypatching the registry after build.
  const hooks = buildHooks(ctx, makeConfig(raw), noopLog, extra?.run);
  const state = getHookState(dir);
  if (state) {
    state.showToast = showToast;
  }
  return { hooks, toasts };
}

describe("config hook", () => {
  it("registers df-profile and df-verify slash commands", async () => {
    const hooks = buildHooks(makeCtx(dir), makeConfig(), noopLog);
    const config: { command?: Record<string, { template?: string; description?: string }> } = {};
    await hooks.config?.(config as never);
    expect(config.command?.["df-profile"]).toBeDefined();
    expect(config.command?.["df-verify"]).toBeDefined();
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

describe("command.execute.before hook", () => {
  it("df-profile changes the profile in config and state", async () => {
    const { hooks, toasts } = buildWithToast();
    await hooks["command.execute.before"]?.({
      command: "df-profile",
      sessionID: "s1",
      arguments: "strict",
    } as never);
    expect(toasts[0].message).toContain('profile set to "strict"');
    expect(toasts[0].variant).toBe("success");
    expect(getHookState(dir)?.config.profile).toBe("strict");
  });

  it("df-profile rejects invalid profiles", async () => {
    const { hooks, toasts } = buildWithToast();
    await hooks["command.execute.before"]?.({
      command: "df-profile",
      sessionID: "s1",
      arguments: "nope",
    } as never);
    expect(toasts[0].message).toContain("Invalid profile");
    expect(toasts[0].variant).toBe("warning");
    expect(getHookState(dir)?.config.profile).toBe("standard");
  });

  it("df-verify runs the completion gate and reports the result", async () => {
    const run = async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
    const { hooks, toasts } = buildWithToast({ commands: { test: "echo ok" } }, { run });
    await hooks["command.execute.before"]?.({
      command: "df-verify",
      sessionID: "s1",
      arguments: "",
    } as never);
    expect(toasts[0].message).toContain("completion gate");
  });

  it("unknown df-* command returns a helpful message", async () => {
    const { hooks, toasts } = buildWithToast();
    await hooks["command.execute.before"]?.({
      command: "df-foobar",
      sessionID: "s1",
      arguments: "",
    } as never);
    expect(toasts[0].message).toContain("Unknown command");
    expect(toasts[0].message).toContain("/df-help");
    expect(toasts[0].variant).toBe("warning");
  });
});
