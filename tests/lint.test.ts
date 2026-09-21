import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config";
import type { CommandResult, RunCommand, RunCommandOptions } from "../src/host";
import {
  DEFAULT_LINT_TIMEOUT_SECONDS,
  detectPreCommitAvailability,
  isLintFailure,
  lintFile,
  matchExclude,
  resolveLintCommand,
  resolvePreCommitCommand,
  summarizeLint,
} from "../src/lint";
import type { LogFn, LogLevel } from "../src/logger";
import type { Config } from "../src/types";

function resolve(raw: Config) {
  return resolveConfig(raw, "/project/.opencode-dev-framework.yml");
}

type EventInput = Parameters<NonNullable<Hooks["event"]>>[0];

function fileEditedEvent(file: string): EventInput {
  return { event: { type: "file.edited", properties: { file } } } as unknown as EventInput;
}

interface RunCall {
  command: string[];
  options?: RunCommandOptions;
}

/** Stubbed command runner recording calls and returning a canned result. */
function stubRun(result: Partial<CommandResult> = {}) {
  const calls: RunCall[] = [];
  const run: RunCommand = async (command, options) => {
    calls.push({ command, options });
    return { stdout: "", stderr: "", exitCode: 0, timedOut: false, ...result };
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

describe("resolveLintCommand", () => {
  it("prefers the per-extension override over the default", () => {
    const config = resolve({
      profile: "standard",
      commands: { lint: { ".go": "golangci-lint run {file}", default: "eslint {file}" } },
    });
    expect(resolveLintCommand(config, "main.go")).toEqual(["golangci-lint", "run", "main.go"]);
  });

  it("falls back to the default command for unknown extensions", () => {
    const config = resolve({
      profile: "standard",
      commands: { lint: { ".go": "golangci-lint run {file}", default: "eslint {file}" } },
    });
    expect(resolveLintCommand(config, "main.ts")).toEqual(["eslint", "main.ts"]);
  });

  it("accepts a plain string as the default command", () => {
    const config = resolve({ profile: "standard", commands: { lint: "eslint {file}" } });
    expect(resolveLintCommand(config, "main.ts")).toEqual(["eslint", "main.ts"]);
  });

  it("returns undefined when no lint command is configured", () => {
    const config = resolve({ profile: "standard" });
    expect(resolveLintCommand(config, "main.go")).toBeUndefined();
  });

  it("keeps commands without a {file} token as-is", () => {
    const config = resolve({ profile: "standard", commands: { lint: "golangci-lint run ./..." } });
    expect(resolveLintCommand(config, "main.go")).toEqual(["golangci-lint", "run", "./..."]);
  });
});

describe("matchExclude", () => {
  it("matches nested globs against relative paths", () => {
    const config = resolve({ profile: "standard", exclude: ["**/generated/**"] });
    expect(matchExclude(config, "src/generated/api.go", "/project")).toBe("**/generated/**");
  });

  it("relativizes absolute paths against the directory", () => {
    const config = resolve({ profile: "standard", exclude: ["dist/**"] });
    expect(matchExclude(config, "/project/dist/out.js", "/project")).toBe("dist/**");
  });

  it("matches slash-less patterns against basenames", () => {
    const config = resolve({ profile: "standard", exclude: ["*.min.js"] });
    expect(matchExclude(config, "assets/app.min.js", "/project")).toBe("*.min.js");
  });

  it("returns undefined when nothing matches", () => {
    const config = resolve({ profile: "standard", exclude: ["dist/**"] });
    expect(matchExclude(config, "src/main.ts", "/project")).toBeUndefined();
  });
});

describe("lintFile", () => {
  it("runs the linter for a changed .go file and captures output", async () => {
    const config = resolve({
      profile: "standard",
      commands: { lint: { ".go": "golangci-lint run {file}" } },
    });
    const { calls, run } = stubRun({ stdout: "all good", exitCode: 0 });

    const outcome = await lintFile(run, config, "main.go", { cwd: "/project", timeout: 30 });

    expect(outcome.skipped).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toEqual(["golangci-lint", "run", "main.go"]);
    expect(calls[0].options).toEqual({ cwd: "/project", timeout: 30 });
    expect(outcome.result?.stdout).toBe("all good");
    expect(isLintFailure(outcome)).toBe(false);
  });

  it("does not lint an excluded file", async () => {
    const config = resolve({
      profile: "standard",
      commands: { lint: "eslint {file}" },
      exclude: ["**/generated/**"],
    });
    const { calls, run } = stubRun();

    const outcome = await lintFile(run, config, "src/generated/api.ts", { cwd: "/project" });

    expect(outcome.skipped).toBe(true);
    expect(outcome.reason).toContain("excluded");
    expect(calls).toHaveLength(0);
  });

  it("skips files with no configured linter", async () => {
    const config = resolve({ profile: "standard" });
    const { calls, run } = stubRun();

    const outcome = await lintFile(run, config, "main.go", { cwd: "/project" });

    expect(outcome.skipped).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("applies the default timeout when none is given", async () => {
    const config = resolve({ profile: "standard", commands: { lint: "eslint {file}" } });
    const { calls, run } = stubRun();

    await lintFile(run, config, "main.ts", { cwd: "/project" });

    expect(calls[0].options?.timeout).toBe(DEFAULT_LINT_TIMEOUT_SECONDS);
  });

  it("treats a timed-out lint as a failure", async () => {
    const config = resolve({ profile: "standard", commands: { lint: "eslint {file}" } });
    const { run } = stubRun({ timedOut: true, exitCode: 1 });

    const outcome = await lintFile(run, config, "main.ts", { cwd: "/project", timeout: 1 });

    expect(isLintFailure(outcome)).toBe(true);
    expect(summarizeLint(outcome)).toContain("timed out");
  });

  it("treats a non-zero exit code as a failure and captures stderr", async () => {
    const config = resolve({ profile: "standard", commands: { lint: "eslint {file}" } });
    const { run } = stubRun({ exitCode: 2, stderr: "1 problem" });

    const outcome = await lintFile(run, config, "main.ts", { cwd: "/project" });

    expect(isLintFailure(outcome)).toBe(true);
    expect(outcome.result?.stderr).toBe("1 problem");
    expect(summarizeLint(outcome)).toContain("exit 2");
  });

  it("uses pre-commit when configured and available", async () => {
    const config = resolve({
      profile: "standard",
      commands: { lint: { ".go": "golangci-lint run {file}" } },
      precommit: "auto",
    });
    const { calls, run } = stubRun();

    const outcome = await lintFile(run, config, "main.go", {
      cwd: "/project",
      precommitAvailable: true,
    });

    expect(outcome.skipped).toBe(false);
    expect(calls[0].command).toEqual(["pre-commit", "run", "--files", "main.go"]);
  });

  it("falls back to configured lint when pre-commit is not available", async () => {
    const config = resolve({
      profile: "standard",
      commands: { lint: { ".go": "golangci-lint run {file}" } },
      precommit: "auto",
    });
    const { calls, run } = stubRun();

    const outcome = await lintFile(run, config, "main.go", {
      cwd: "/project",
      precommitAvailable: false,
    });

    expect(outcome.skipped).toBe(false);
    expect(calls[0].command).toEqual(["golangci-lint", "run", "main.go"]);
  });

  it("ignores pre-commit when precommit is off", async () => {
    const config = resolve({
      profile: "standard",
      commands: { lint: { ".go": "golangci-lint run {file}" } },
      precommit: "off",
    });
    const { calls, run } = stubRun();

    await lintFile(run, config, "main.go", { cwd: "/project", precommitAvailable: true });

    expect(calls[0].command).toEqual(["golangci-lint", "run", "main.go"]);
  });
});

describe("resolvePreCommitCommand", () => {
  it("returns pre-commit run --files with the file path", () => {
    expect(resolvePreCommitCommand("src/main.go")).toEqual([
      "pre-commit",
      "run",
      "--files",
      "src/main.go",
    ]);
  });
});

describe("detectPreCommitAvailability", () => {
  it("returns true when pre-commit --version succeeds", async () => {
    const { run } = stubRun({ stdout: "pre-commit 3.0.0" });
    const available = await detectPreCommitAvailability(run, "/project");
    expect(available).toBe(true);
  });

  it("returns false when pre-commit --version fails", async () => {
    const { run } = stubRun({ exitCode: 127 });
    const available = await detectPreCommitAvailability(run, "/project");
    expect(available).toBe(false);
  });
});
