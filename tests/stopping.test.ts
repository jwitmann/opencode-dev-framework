import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginInput } from "@opencode-ai/plugin";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHooks, type HooksWithStopping } from "../src/index";
import type { CommandResult, RunCommand } from "../src/host";
import type { LogFn } from "../src/logger";
import { getHookState } from "../src/registry";
import type { Config, ResolvedConfig } from "../src/types";
import { resolveConfig } from "../src/config";

const CONFIG_PATH = "/project/.opencode-dev-framework.yml";

function resolve(raw: Config): ResolvedConfig {
  return resolveConfig(raw, CONFIG_PATH);
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "odf-stopping-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeCtx(directory: string): PluginInput {
  return { directory } as PluginInput;
}

const noopLog: LogFn = async () => {};

function stubRun(exitCode: number): RunCommand {
  return async (): Promise<CommandResult> => ({
    stdout: "",
    stderr: exitCode === 0 ? "" : "failure",
    exitCode,
    timedOut: false,
  });
}

function makeOutput(): { context: string[] } {
  return { context: [] };
}

describe("experimental.session.stopping", () => {
  it("does not add context when the gate passes", async () => {
    const config = resolve({
      profile: "standard",
      commands: { test: "true" },
      gate: { run_typecheck: false, run_tests: true, skip_unchanged: false },
    });
    const hooks: HooksWithStopping = buildHooks(makeCtx(dir), config, noopLog, stubRun(0));
    const stopping = hooks["experimental.session.stopping"];
    expect(stopping).toBeDefined();

    const output = makeOutput();
    await stopping?.({ sessionID: "s1" }, output);
    expect(output.context).toEqual([]);
    expect(getHookState(dir)?.blockCounts.get("s1")).toBeUndefined();
  });

  it("adds blocking context when the gate fails", async () => {
    const config = resolve({
      profile: "standard",
      commands: { test: "false" },
      gate: { run_typecheck: false, run_tests: true, skip_unchanged: false },
    });
    const hooks: HooksWithStopping = buildHooks(makeCtx(dir), config, noopLog, stubRun(1));
    const stopping = hooks["experimental.session.stopping"];

    const output = makeOutput();
    await stopping?.({ sessionID: "s1" }, output);
    expect(output.context.length).toBe(1);
    expect(output.context[0]).toContain("completion gate blocked");
    expect(output.context[0]).toContain("block 1/3");
    expect(getHookState(dir)?.blockCounts.get("s1")).toBe(1);
  });

  it("tracks block counts per session, not per directory", async () => {
    const config = resolve({
      profile: "standard",
      commands: { test: "false" },
      gate: { run_typecheck: false, run_tests: true, skip_unchanged: false },
    });
    const hooks: HooksWithStopping = buildHooks(makeCtx(dir), config, noopLog, stubRun(1));
    const stopping = hooks["experimental.session.stopping"];

    await stopping?.({ sessionID: "s1" }, makeOutput());
    await stopping?.({ sessionID: "s1" }, makeOutput());

    const other = makeOutput();
    await stopping?.({ sessionID: "s2" }, other);
    expect(other.context.length).toBe(1);
    expect(other.context[0]).toContain("block 1/3");
    expect(getHookState(dir)?.blockCounts.get("s1")).toBe(2);
    expect(getHookState(dir)?.blockCounts.get("s2")).toBe(1);
  });

  it("does not run the gate when the profile is off", async () => {
    const config = resolve({
      profile: "off",
      commands: { test: "false" },
      gate: { run_typecheck: false, run_tests: true, skip_unchanged: false },
    });
    const hooks: HooksWithStopping = buildHooks(makeCtx(dir), config, noopLog, stubRun(1));
    const stopping = hooks["experimental.session.stopping"];

    const output = makeOutput();
    await stopping?.({ sessionID: "s1" }, output);
    expect(output.context).toEqual([]);
    expect(getHookState(dir)?.blockCounts.size).toBe(0);
  });

  it("stops blocking after gate.max_blocks", async () => {
    const config = resolve({
      profile: "standard",
      commands: { test: "false" },
      gate: { run_typecheck: false, run_tests: true, skip_unchanged: false, max_blocks: 2 },
    });
    const hooks: HooksWithStopping = buildHooks(makeCtx(dir), config, noopLog, stubRun(1));
    const stopping = hooks["experimental.session.stopping"];

    const first = makeOutput();
    await stopping?.({ sessionID: "s1" }, first);
    expect(first.context.length).toBe(1);

    const second = makeOutput();
    await stopping?.({ sessionID: "s1" }, second);
    expect(second.context.length).toBe(1);

    const third = makeOutput();
    await stopping?.({ sessionID: "s1" }, third);
    expect(third.context).toEqual([]);
    expect(getHookState(dir)?.blockCounts.get("s1")).toBe(3);
  });

  it("uses the session-to-directory mapping set by system.transform", async () => {
    const config = resolve({
      profile: "standard",
      commands: { test: "false" },
      gate: { run_typecheck: false, run_tests: true, skip_unchanged: false },
    });
    const hooks: HooksWithStopping = buildHooks(makeCtx(dir), config, noopLog, stubRun(1));

    const transform = hooks["experimental.chat.system.transform"];
    expect(transform).toBeDefined();
    await transform?.({ sessionID: "s1", model: {} as never }, { system: [] });

    const stopping = hooks["experimental.session.stopping"];
    const output = makeOutput();
    await stopping?.({ sessionID: "s1" }, output);
    expect(output.context.length).toBe(1);
  });
});
