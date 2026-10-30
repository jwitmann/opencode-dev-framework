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
import { createLintLimiter } from "../src/lint";
import type { Config } from "../src/types";

function resolve(raw: Config) {
  return resolveConfig(raw, "/project/.opencode-dev-framework.yml");
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

describe("runGate acceptance commands", () => {
  const BASE = {
    profile: "standard",
    commands: { typecheck: "true", test: "true" },
  } as const;

  it("runs no acceptance steps by default (old behavior preserved)", async () => {
    const config = resolve({ profile: "standard", commands: GATE_COMMANDS });
    const { calls, run } = stubRun();

    const report = await runGate(run, config, ["src/a.ts"], { cwd: "/project" });

    expect(report.steps.some((s) => s.name.startsWith("acceptance:"))).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("runs acceptance checks last, in declared order, labeled acceptance:<name>", async () => {
    const config = resolve({
      ...BASE,
      gate: {
        acceptance: [
          { name: "api-contract", command: "verify-api" },
          { name: "migration-safety", command: "check-migrations" },
        ],
      },
    });
    const { calls, run } = stubRun();

    const report = await runGate(run, config, ["src/a.ts"], { cwd: "/project" });

    expect(report.ok).toBe(true);
    expect(report.steps.map((s) => s.name)).toEqual([
      "typecheck",
      "test",
      "acceptance:api-contract",
      "acceptance:migration-safety",
    ]);
    expect(calls.map((c) => c.command[0])).toEqual([
      "true",
      "true",
      "verify-api",
      "check-migrations",
    ]);
  });

  it("aggregates: one failed acceptance still runs the rest and fails the report", async () => {
    const config = resolve({
      ...BASE,
      gate: {
        acceptance: [
          { name: "api-contract", command: "verify-api" },
          { name: "migration-safety", command: "check-migrations" },
        ],
      },
    });
    const { calls, run } = stubRun((command) =>
      command[0] === "verify-api" ? { exitCode: 1, stderr: "contract drift" } : {},
    );

    const report = await runGate(run, config, ["src/a.ts"], { cwd: "/project" });

    expect(report.ok).toBe(false);
    expect(report.failedSteps.map((s) => s.name)).toEqual(["acceptance:api-contract"]);
    expect(report.failedSteps[0].result?.stderr).toBe("contract drift");
    // Both acceptance checks ran despite the first failing.
    expect(calls.map((c) => c.command[0])).toContain("check-migrations");
    expect(summarizeGate(report)).toContain("acceptance:api-contract: failed (exit 1)");
  });

  it("per-check timeout overrides the gate timeout, which falls back to the default", async () => {
    const config = resolve({
      ...BASE,
      gate: {
        timeout: 60,
        acceptance: [
          { name: "slow", command: "verify-slow", timeout: 120 },
          { name: "plain", command: "verify-plain" },
        ],
      },
    });
    const { calls, run } = stubRun();

    await runGate(run, config, ["src/a.ts"], { cwd: "/project" });

    const timeoutFor = (argv0: string) =>
      calls.find((c) => c.command[0] === argv0)?.options?.timeout;
    expect(timeoutFor("true")).toBe(60);
    expect(timeoutFor("verify-slow")).toBe(120);
    expect(timeoutFor("verify-plain")).toBe(60);

    const noGateTimeout = resolve({
      ...BASE,
      gate: {
        acceptance: [{ name: "plain", command: "verify-plain" }],
      },
    });
    const second = stubRun();
    await runGate(second.run, noGateTimeout, ["src/a.ts"], { cwd: "/project" });
    expect(second.calls.find((c) => c.command[0] === "verify-plain")?.options?.timeout).toBe(
      DEFAULT_GATE_TIMEOUT_SECONDS,
    );
  });

  it("substitutes {files} and uses the project cwd", async () => {
    const config = resolve({
      ...BASE,
      gate: { acceptance: [{ name: "contract", command: "verify-contract {files}" }] },
    });
    const { calls, run } = stubRun();

    await runGate(run, config, ["src/a.ts", "src/b.ts"], { cwd: "/project" });

    const call = calls.find((c) => c.command[0] === "verify-contract");
    expect(call?.command).toEqual(["verify-contract", "src/a.ts", "src/b.ts"]);
    expect(call?.options?.cwd).toBe("/project");
  });

  it("skips acceptance checks when the gate skips", async () => {
    const config = resolve({
      ...BASE,
      gate: { acceptance: [{ name: "contract", command: "verify-contract" }] },
    });
    const { calls, run } = stubRun();

    const report = await runGate(run, config, [], { cwd: "/project" });

    expect(report.ran).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("runGate concurrency", () => {
  it("runs typecheck and test concurrently while reporting in stable order", async () => {
    const config = resolve({ profile: "standard", commands: GATE_COMMANDS });
    const started: string[] = [];
    let testStarted!: () => void;
    const testStartedGate = new Promise<void>((resolve) => {
      testStarted = resolve;
    });
    const timeout = new Promise<"timed-out">((resolve) => {
      setTimeout(() => resolve("timed-out"), 1000);
    });
    let overlapped = false;
    const run: RunCommand = async (command) => {
      started.push(command[0]);
      if (command[0] === "npm") {
        testStarted();
      }
      if (command[0] === "tsc") {
        // Under sequential execution the test never starts while typecheck
        // is pending, so this races to "timed-out"; concurrently it wins.
        overlapped =
          (await Promise.race([testStartedGate.then(() => "started" as const), timeout])) ===
          "started";
      }
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    };

    const report = await runGate(run, config, ["src/a.ts"], { cwd: "/project" });

    expect(report.ok).toBe(true);
    expect(overlapped).toBe(true);
    expect(report.steps.map((s) => s.name)).toEqual(["typecheck", "test"]);
  });

  it("bounds concurrent per-file lints and keeps declared step order", async () => {
    const config = resolve({
      profile: "strict",
      commands: { ...GATE_COMMANDS, lint: "eslint {file}" },
    });
    const files = Array.from({ length: 8 }, (_, i) => `src/f${i}.ts`);
    let active = 0;
    let maxActive = 0;
    const run: RunCommand = async (command) => {
      if (command[0] === "eslint") {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
      }
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    };

    const report = await runGate(run, config, files, { cwd: "/project" });

    expect(report.ok).toBe(true);
    expect(maxActive).toBe(4);
    expect(report.steps.map((s) => s.name)).toEqual([
      "typecheck",
      "test",
      ...files.map((f) => `lint:${f}`),
    ]);
  });

  it("honors a shared limiter stricter than the internal cap", async () => {
    const lintOnly = resolve({
      profile: "strict",
      gate: { run_typecheck: false, run_tests: false, lint_changed: true },
      commands: { lint: "eslint {file}" },
    });
    const files = ["a.ts", "b.ts", "c.ts"];
    let active = 0;
    let maxActive = 0;
    const serialRun: RunCommand = async (command) => {
      if (command[0] === "eslint") {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
      }
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    };

    const report = await runGate(serialRun, lintOnly, files, {
      cwd: "/project",
      lintLimiter: createLintLimiter(1),
    });

    expect(report.ok).toBe(true);
    expect(maxActive).toBe(1);
    expect(report.steps.map((s) => s.name)).toEqual(files.map((f) => `lint:${f}`));
  });
});
