import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config";
import {
  createChangedFileTracker,
  DEFAULT_GATE_TIMEOUT_SECONDS,
  runGate,
  substituteFiles,
  summarizeGate,
} from "../src/gate";
import type { CommandResult, RunCommand, RunCommandOptions } from "../src/host";
import { buildHooks } from "../src/index";
import type { LogFn, LogLevel } from "../src/logger";
import type { Config } from "../src/types";

function resolve(raw: Config) {
  return resolveConfig(raw, "/project/.opencode-dev-framework.yml");
}

type EventInput = Parameters<NonNullable<Hooks["event"]>>[0];

function eventOf(type: string, properties: Record<string, unknown>): EventInput {
  return { event: { type, properties } } as unknown as EventInput;
}

interface RunCall {
  command: string[];
  options?: RunCommandOptions;
}

type ResultFor = (command: string[]) => Partial<CommandResult>;

/** Stubbed runner; `resultFor` customizes results per command. */
function stubRun(resultFor: ResultFor = () => ({})) {
  const calls: RunCall[] = [];
  const run: RunCommand = async (command, options) => {
    calls.push({ command, options });
    return { stdout: "", stderr: "", exitCode: 0, timedOut: false, ...resultFor(command) };
  };
  return { calls, run };
}

interface LogEntry {
  level: LogLevel;
  message: string;
  extra?: Record<string, unknown>;
}

function stubLog() {
  const entries: LogEntry[] = [];
  const log: LogFn = async (level, message, extra) => {
    entries.push({ level, message, extra });
  };
  return { entries, log };
}

const stubCtx = { directory: "/project" } as PluginInput;

const GATE_COMMANDS = {
  typecheck: "tsc --noEmit",
  test: "npm test",
  test_changed: "vitest related {files}",
};

describe("changed-file tracker", () => {
  it("tracks, deduplicates, and clears files", () => {
    const tracker = createChangedFileTracker();
    tracker.add("src/a.ts");
    tracker.add("src/b.ts");
    tracker.add("src/a.ts");
    expect(tracker.getChangedFiles()).toEqual(["src/a.ts", "src/b.ts"]);
    tracker.clearChangedFiles();
    expect(tracker.getChangedFiles()).toEqual([]);
  });

  it("stores absolute paths relative to the directory", () => {
    const tracker = createChangedFileTracker();
    tracker.add("/project/src/a.ts", "/project");
    expect(tracker.getChangedFiles()).toEqual(["src/a.ts"]);
  });
});

describe("substituteFiles", () => {
  it("expands a standalone {files} token to multiple argv entries", () => {
    expect(substituteFiles("vitest related {files}", ["a.ts", "b.ts"])).toEqual([
      "vitest",
      "related",
      "a.ts",
      "b.ts",
    ]);
  });

  it("replaces an embedded {files} token inline", () => {
    expect(substituteFiles("go test {files}", ["./pkg/..."])).toEqual(["go", "test", "./pkg/..."]);
  });

  it("leaves commands without the token unchanged", () => {
    expect(substituteFiles("npm test", ["a.ts"])).toEqual(["npm", "test"]);
  });
});

describe("runGate", () => {
  it("passes when typecheck and tests are green", async () => {
    const config = resolve({ profile: "standard", commands: GATE_COMMANDS });
    const { calls, run } = stubRun();

    const report = await runGate(run, config, ["src/a.ts"], { cwd: "/project" });

    expect(report.ran).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.failedSteps).toEqual([]);
    expect(calls.map((c) => c.command[0])).toEqual(["tsc", "npm"]);
  });

  it("reports failure when the test step fails and still runs all steps", async () => {
    const config = resolve({ profile: "standard", commands: GATE_COMMANDS });
    const { calls, run } = stubRun((command) =>
      command[0] === "npm" ? { exitCode: 1, stderr: "1 failing test" } : {},
    );

    const report = await runGate(run, config, ["src/a.ts"], { cwd: "/project" });

    expect(report.ok).toBe(false);
    expect(report.failedSteps.map((s) => s.name)).toEqual(["test"]);
    expect(report.failedSteps[0].result?.stderr).toBe("1 failing test");
    // Aggregation: typecheck ran even though it comes first and passed, and no
    // step was aborted by the failure.
    expect(calls).toHaveLength(2);
  });

  it("skips when skip_unchanged is set and nothing changed", async () => {
    const config = resolve({ profile: "standard", commands: GATE_COMMANDS });
    const { calls, run } = stubRun();

    const report = await runGate(run, config, [], { cwd: "/project" });

    expect(report.ran).toBe(false);
    expect(report.reason).toBe("no changed files");
    expect(report.ok).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("runs with no changes when skip_unchanged is false", async () => {
    const config = resolve({
      profile: "standard",
      commands: GATE_COMMANDS,
      gate: { skip_unchanged: false },
    });
    const { calls, run } = stubRun();

    const report = await runGate(run, config, [], { cwd: "/project" });

    expect(report.ran).toBe(true);
    expect(calls.map((c) => c.command[0])).toEqual(["tsc", "npm"]);
  });

  it("scopes tests to changed files when scope is changed", async () => {
    const config = resolve({
      profile: "standard",
      commands: GATE_COMMANDS,
      gate: { scope: "changed" },
    });
    const { calls, run } = stubRun();

    const report = await runGate(run, config, ["src/a.ts", "src/b.ts"], { cwd: "/project" });

    expect(report.ok).toBe(true);
    const testCall = calls.find((c) => c.command[0] === "vitest");
    expect(testCall?.command).toEqual(["vitest", "related", "src/a.ts", "src/b.ts"]);
  });

  it("skips the test step when scope is changed but test_changed is not configured", async () => {
    const config = resolve({
      profile: "standard",
      commands: { test: "npm test" },
      gate: { scope: "changed", run_typecheck: false },
    });
    const { run } = stubRun();

    const report = await runGate(run, config, ["src/a.ts"], { cwd: "/project" });

    expect(report.ran).toBe(false);
    expect(report.steps[0]).toMatchObject({
      name: "test",
      skipped: true,
      reason: "no test_changed command configured",
    });
  });

  it("applies the configured timeout to every command", async () => {
    const config = resolve({
      profile: "standard",
      commands: GATE_COMMANDS,
      gate: { timeout: 42 },
    });
    const { calls, run } = stubRun();

    await runGate(run, config, ["src/a.ts"], { cwd: "/project" });

    expect(calls.every((c) => c.options?.timeout === 42)).toBe(true);
  });

  it("falls back to the default timeout when none is configured", async () => {
    const config = resolve({ profile: "standard", commands: GATE_COMMANDS });
    const { calls, run } = stubRun();

    await runGate(run, config, ["src/a.ts"], { cwd: "/project" });

    expect(calls.every((c) => c.options?.timeout === DEFAULT_GATE_TIMEOUT_SECONDS)).toBe(true);
  });

  it("lints each changed file when lint_changed is enabled", async () => {
    const config = resolve({
      profile: "strict",
      commands: { lint: { ".go": "golangci-lint run {file}" } },
      gate: { run_typecheck: false, run_tests: false, lint_changed: true },
    });
    const { calls, run } = stubRun();

    const report = await runGate(run, config, ["main.go", "util.go"], { cwd: "/project" });

    expect(report.ok).toBe(true);
    expect(report.steps.map((s) => s.name)).toEqual(["lint:main.go", "lint:util.go"]);
    expect(calls.map((c) => c.command)).toEqual([
      ["golangci-lint", "run", "main.go"],
      ["golangci-lint", "run", "util.go"],
    ]);
  });

  it("marks the gate failed when a lint step fails", async () => {
    const config = resolve({
      profile: "strict",
      commands: { lint: "eslint {file}" },
      gate: { run_typecheck: false, run_tests: false, lint_changed: true },
    });
    const { run } = stubRun(() => ({ exitCode: 2 }));

    const report = await runGate(run, config, ["src/a.ts"], { cwd: "/project" });

    expect(report.ok).toBe(false);
    expect(report.failedSteps.map((s) => s.name)).toEqual(["lint:src/a.ts"]);
  });

  it("reports ran=false when no gate commands are configured", async () => {
    const config = resolve({ profile: "standard" });
    const { run } = stubRun();

    const report = await runGate(run, config, ["src/a.ts"], { cwd: "/project" });

    expect(report.ran).toBe(false);
    expect(report.reason).toBe("no gate commands configured");
  });

  it("summarizes pass, failure, and skip outcomes", async () => {
    const config = resolve({ profile: "standard", commands: GATE_COMMANDS });

    const green = await runGate(stubRun().run, config, ["src/a.ts"], { cwd: "/project" });
    expect(summarizeGate(green)).toContain("completion gate passed");

    const failing = await runGate(stubRun(() => ({ exitCode: 1 })).run, config, ["src/a.ts"], {
      cwd: "/project",
    });
    expect(summarizeGate(failing)).toContain("completion gate FAILED");
    expect(summarizeGate(failing)).toContain("typecheck: failed (exit 1)");

    expect(summarizeGate(await runGate(stubRun().run, config, [], {}))).toContain("skipped");
  });
});

describe("session.idle hook wiring", () => {
  const gateConfig: Config = {
    profile: "standard",
    commands: GATE_COMMANDS,
    gate: { skip_unchanged: false },
  };

  it("runs the gate on session.idle and clears tracked files", async () => {
    const config = resolve(gateConfig);
    const { calls, run } = stubRun();
    const { entries, log } = stubLog();
    const hooks = buildHooks(stubCtx, config, log, run);

    await hooks.event?.(eventOf("file.edited", { file: "/project/src/a.ts" }));
    await hooks.event?.(eventOf("session.idle", { sessionID: "s1" }));

    expect(calls.map((c) => c.command[0])).toEqual(["tsc", "npm"]);
    expect(entries.some((e) => e.level === "info" && e.message.includes("gate passed"))).toBe(true);

    // Tracker was cleared: a second idle with no new edits still runs
    // (skip_unchanged false) but the changed-file list is empty.
    await hooks.event?.(eventOf("session.idle", { sessionID: "s1" }));
    const secondTestCall = calls.filter((c) => c.command[0] === "npm");
    expect(secondTestCall).toHaveLength(2);
  });

  it("tracks edited files even when on_edit.lint is disabled", async () => {
    const config = resolve({
      profile: "standard",
      commands: { test_changed: "vitest related {files}" },
      gate: { scope: "changed", run_typecheck: false, run_tests: true },
      on_edit: { lint: false },
    });
    const { calls, run } = stubRun();
    const hooks = buildHooks(stubCtx, config, stubLog().log, run);

    await hooks.event?.(eventOf("file.edited", { file: "/project/src/a.ts" }));
    await hooks.event?.(eventOf("session.idle", { sessionID: "s1" }));

    expect(calls[0].command).toEqual(["vitest", "related", "src/a.ts"]);
  });

  it("skips the gate when unchanged and skip_unchanged is set", async () => {
    const config = resolve({ profile: "standard", commands: GATE_COMMANDS });
    const { calls, run } = stubRun();
    const { entries, log } = stubLog();
    const hooks = buildHooks(stubCtx, config, log, run);

    await hooks.event?.(eventOf("session.idle", { sessionID: "s1" }));

    expect(calls).toHaveLength(0);
    expect(entries.some((e) => e.level === "debug" && e.message.includes("gate skipped"))).toBe(
      true,
    );
  });

  it("logs an error with failed step details when the gate fails", async () => {
    const config = resolve(gateConfig);
    const { run } = stubRun((command) =>
      command[0] === "npm" ? { exitCode: 1, stderr: "boom" } : {},
    );
    const { entries, log } = stubLog();
    const hooks = buildHooks(stubCtx, config, log, run);

    await hooks.event?.(eventOf("session.idle", { sessionID: "s1" }));

    const failure = entries.find((e) => e.level === "error");
    expect(failure?.message).toContain("completion gate FAILED");
    const failedSteps = failure?.extra?.failedSteps as Array<Record<string, unknown>>;
    expect(failedSteps[0]).toMatchObject({ name: "test", exitCode: 1, stderr: "boom" });
  });

  it("logs a warning instead of an error when block_on_failure is false", async () => {
    const config = resolve({
      ...gateConfig,
      profile: "advisory",
      gate: { skip_unchanged: false, block_on_failure: false },
    });
    const { run } = stubRun(() => ({ exitCode: 1 }));
    const { entries, log } = stubLog();
    const hooks = buildHooks(stubCtx, config, log, run);

    await hooks.event?.(eventOf("session.idle", { sessionID: "s1" }));

    expect(entries.some((e) => e.level === "error")).toBe(false);
    expect(entries.some((e) => e.level === "warn" && e.message.includes("FAILED"))).toBe(true);
  });
});
