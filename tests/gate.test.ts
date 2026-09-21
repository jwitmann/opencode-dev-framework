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
