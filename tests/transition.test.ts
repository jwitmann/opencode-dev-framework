import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginInput } from "@opencode-ai/plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildHooks } from "../src/index";
import { updateHookState } from "../src/registry";
import { resolveConfig } from "../src/config";
import type { LogFn } from "../src/logger";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "odf-transition-"));
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

const PROTECT = [".env*", "go.sum", "**/vendor/**"];

describe("off -> standard runtime transition", () => {
  it("does not crash and injects the constitution after a runtime switch to standard", async () => {
    // Mirrors a session that started with profile: off (no hooks would have run yet).
    const hooks = buildHooks(makeCtx(dir), makeConfig({ profile: "off" }), noopLog);
    // Simulate /df-profile standard writing the config + updating hook state.
    updateHookState(dir, {
      config: makeConfig({ profile: "standard" }),
      constitution: "CONSTITUTION",
    });

    const log = vi.fn<LogFn>();
    updateHookState(dir, { log });

    const output: { system: string[] } = { system: ["base"] };
    await expect(
      hooks["experimental.chat.system.transform"]?.({ sessionID: "tx1" } as never, output as never),
    ).resolves.toBeUndefined();
    expect(output.system).toEqual(["base\n\nCONSTITUTION"]);
    expect(log).toHaveBeenCalledWith("info", "constitution injected into system prompt", undefined);
  });

  it("does not inject the constitution while the profile is off", async () => {
    const hooks = buildHooks(makeCtx(dir), makeConfig({ profile: "off" }), noopLog);
    const output: { system: string[] } = { system: ["base"] };
    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "tx2" } as never,
      output as never,
    );
    expect(output.system).toEqual(["base"]);
  });

  it("tool.execute.before is a no-op under off and does not throw", async () => {
    const hooks = buildHooks(makeCtx(dir), makeConfig({ profile: "off" }), noopLog);
    await expect(
      hooks["tool.execute.before"]?.(
        { sessionID: "tx3", tool: "edit" } as never,
        { args: { filePath: ".env" } } as never,
      ),
    ).resolves.toBeUndefined();
  });

  it("tool.execute.before still blocks under strict (guard not over-suppressed)", async () => {
    const hooks = buildHooks(
      makeCtx(dir),
      makeConfig({ profile: "strict", protect: PROTECT }),
      noopLog,
    );
    await expect(
      hooks["tool.execute.before"]?.(
        { sessionID: "tx4", tool: "edit" } as never,
        { args: { filePath: ".env" } } as never,
      ),
    ).rejects.toThrow(/protected path/);
  });

  it("survives a missing HookState.log via safeLog fallback without throwing", async () => {
    const hooks = buildHooks(
      makeCtx(dir),
      makeConfig({ profile: "standard" }),
      noopLog,
      undefined,
      undefined,
      "CONSTITUTION",
    );
    // Corrupt the stored log to undefined, as could happen mid-transition.
    updateHookState(dir, { log: undefined as never });
    const output: { system: string[] } = { system: ["base"] };
    await expect(
      hooks["experimental.chat.system.transform"]?.({ sessionID: "tx5" } as never, output as never),
    ).resolves.toBeUndefined();
    expect(output.system).toEqual(["base\n\nCONSTITUTION"]);
  });
});
