import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config";
import type { CommandResult, RunCommand, RunCommandOptions } from "../src/host";
import { buildHooks } from "../src/index";
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

const stubCtx = { directory: "/project" } as PluginInput;

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

describe("file.edited hook wiring", () => {
  const withLint: Config = {
    profile: "standard",
    commands: { lint: { ".go": "golangci-lint run {file}" } },
  };

  it("runs the linter on file.edited when on_edit.lint is enabled", async () => {
    const config = resolve(withLint);
    const { calls, run } = stubRun();
    const { entries, log } = stubLog();
    const hooks = buildHooks(stubCtx, config, log, run);

    await hooks.event?.(fileEditedEvent("/project/main.go"));

    expect(calls).toHaveLength(1);
    expect(calls[0].command).toEqual(["golangci-lint", "run", "/project/main.go"]);
    expect(entries.some((e) => e.level === "info" && e.message.includes("lint passed"))).toBe(true);
  });

  it("ignores non file.edited events", async () => {
    const config = resolve(withLint);
    const { calls, run } = stubRun();
    const hooks = buildHooks(stubCtx, config, stubLog().log, run);

    await hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: "s1" } },
    } as unknown as EventInput);

    expect(calls).toHaveLength(0);
  });

  it("detects pre-commit availability on first file.edited when precommit is auto", async () => {
    const config = resolve({ ...withLint, precommit: "auto" });
    const { calls, run } = stubRun();
    const hooks = buildHooks(stubCtx, config, stubLog().log, run);

    await hooks.event?.(fileEditedEvent("/project/main.go"));

    expect(calls).toHaveLength(2);
    expect(calls[0].command).toEqual(["pre-commit", "--version"]);
    expect(calls[1].command).toEqual(["pre-commit", "run", "--files", "/project/main.go"]);
  });

  it("does nothing when on_edit.lint is disabled", async () => {
    const config = resolve({ ...withLint, on_edit: { lint: false } });
    const { calls, run } = stubRun();
    const hooks = buildHooks(stubCtx, config, stubLog().log, run);

    await hooks.event?.(fileEditedEvent("/project/main.go"));

    expect(calls).toHaveLength(0);
  });

  it("logs an error but does not throw on lint failure outside strict", async () => {
    const config = resolve(withLint);
    const { run } = stubRun({ exitCode: 1, stderr: "boom" });
    const { entries, log } = stubLog();
    const hooks = buildHooks(stubCtx, config, log, run);

    await hooks.event?.(fileEditedEvent("/project/main.go"));

    const error = entries.find((e) => e.level === "error");
    expect(error?.message).toContain("lint failed");
    expect(error?.extra?.stderr).toBe("boom");
  });

  it("throws on lint failure in the strict profile", async () => {
    const config = resolve({ ...withLint, profile: "strict" });
    const { run } = stubRun({ exitCode: 1 });
    const hooks = buildHooks(stubCtx, config, stubLog().log, run);

    await expect(hooks.event?.(fileEditedEvent("/project/main.go"))).rejects.toThrow(
      "[opencode-dev-framework] lint failed",
    );
  });
});
