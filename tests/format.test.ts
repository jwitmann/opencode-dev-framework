import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/core/config";
import type { CommandResult, RunCommand, RunCommandOptions } from "../src/core/host";
import {
  DEFAULT_FORMAT_TIMEOUT_SECONDS,
  formatFile,
  isFormatFailure,
  resolveFormatCommand,
  summarizeFormat,
} from "../src/core/lint";
import type { Config } from "../src/core/types";

function resolve(raw: Config) {
  return resolveConfig(raw, "/project/.opencode-dev-framework.yml");
}

interface RunCall {
  command: string[];
  options?: RunCommandOptions;
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Real temp dir with the named file materialized (ghosts stay absent). */
function makeTempDir(...files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "odf-format-"));
  tempDirs.push(dir);
  for (const f of files) writeFileSync(join(dir, f), "export {};\n", "utf8");
  return dir;
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

describe("resolveFormatCommand", () => {
  it("prefers the per-extension override over the default", () => {
    const config = resolve({
      profile: "standard",
      commands: { format: { ".go": "gofumpt -w {file}", default: "prettier --write {file}" } },
    });
    expect(resolveFormatCommand(config, "main.go")).toEqual(["gofumpt", "-w", "main.go"]);
  });

  it("falls back to the default command for unknown extensions", () => {
    const config = resolve({
      profile: "standard",
      commands: { format: { ".go": "gofumpt -w {file}", default: "prettier --write {file}" } },
    });
    expect(resolveFormatCommand(config, "main.ts")).toEqual(["prettier", "--write", "main.ts"]);
  });

  it("accepts a plain string as the default command", () => {
    const config = resolve({
      profile: "standard",
      commands: { format: "prettier --write {file}" },
    });
    expect(resolveFormatCommand(config, "main.ts")).toEqual(["prettier", "--write", "main.ts"]);
  });

  it("returns undefined when no format command is configured", () => {
    const config = resolve({ profile: "standard" });
    expect(resolveFormatCommand(config, "main.go")).toBeUndefined();
  });

  it("substitutes the {dir} token with the file's directory", () => {
    const config = resolve({ profile: "standard", commands: { format: "black {dir}" } });
    expect(resolveFormatCommand(config, "pkg/api/server.py")).toEqual(["black", "pkg/api"]);
  });
});

describe("formatFile", () => {
  it("runs the formatter for a changed .go file and captures output", async () => {
    const dir = makeTempDir("main.go");
    const config = resolve({
      profile: "standard",
      commands: { format: { ".go": "gofumpt -w {file}" } },
    });
    const { calls, run } = stubRun({ stdout: "formatted", exitCode: 0 });

    const outcome = await formatFile(run, config, "main.go", {
      cwd: dir,
      timeout: 30,
    });

    expect(outcome.skipped).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toEqual(["gofumpt", "-w", "main.go"]);
    expect(calls[0].options).toEqual({ cwd: dir, timeout: 30 });
    expect(outcome.result?.stdout).toBe("formatted");
    expect(isFormatFailure(outcome)).toBe(false);
  });

  it("does not format an excluded file", async () => {
    const config = resolve({
      profile: "standard",
      commands: { format: "prettier --write {file}" },
      exclude: ["**/generated/**"],
    });
    const { calls, run } = stubRun();

    const outcome = await formatFile(run, config, "src/generated/api.ts", { cwd: "/project" });

    expect(outcome.skipped).toBe(true);
    expect(outcome.reason).toContain("excluded");
    expect(calls).toHaveLength(0);
  });

  it("skips files with no configured formatter", async () => {
    const config = resolve({ profile: "standard" });
    const { calls, run } = stubRun();

    const outcome = await formatFile(run, config, "main.go", { cwd: "/project" });

    expect(outcome.skipped).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("applies the default timeout when none is given", async () => {
    const dir = makeTempDir("main.ts");
    const config = resolve({
      profile: "standard",
      commands: { format: "prettier --write {file}" },
    });
    const { calls, run } = stubRun();

    await formatFile(run, config, "main.ts", { cwd: dir });

    expect(calls[0].options?.timeout).toBe(DEFAULT_FORMAT_TIMEOUT_SECONDS);
  });

  it("treats a timed-out format as a failure", async () => {
    const dir = makeTempDir("main.ts");
    const config = resolve({
      profile: "standard",
      commands: { format: "prettier --write {file}" },
    });
    const { run } = stubRun({ timedOut: true, exitCode: 1 });

    const outcome = await formatFile(run, config, "main.ts", { cwd: dir, timeout: 1 });

    expect(isFormatFailure(outcome)).toBe(true);
    expect(summarizeFormat(outcome)).toContain("timed out");
  });

  it("treats a non-zero exit code as a failure and captures stderr", async () => {
    const dir = makeTempDir("main.ts");
    const config = resolve({
      profile: "standard",
      commands: { format: "prettier --write {file}" },
    });
    const { run } = stubRun({ exitCode: 2, stderr: "parse error" });

    const outcome = await formatFile(run, config, "main.ts", { cwd: dir });

    expect(isFormatFailure(outcome)).toBe(true);
    expect(outcome.result?.stderr).toBe("parse error");
    expect(summarizeFormat(outcome)).toContain("exit 2");
  });
});

describe("formatFile deleted files (ghost entries)", () => {
  it("skips files that no longer exist without running the formatter", async () => {
    const dir = makeTempDir();
    const config = resolve({
      profile: "standard",
      commands: { format: { ".go": "gofumpt -w {file}" } },
    });
    const { calls, run } = stubRun({ exitCode: 1 });

    const outcome = await formatFile(run, config, "deleted.go", { cwd: dir });

    expect(outcome.skipped).toBe(true);
    expect(outcome.reason).toContain("no longer exists");
    expect(calls).toHaveLength(0);
    expect(isFormatFailure(outcome)).toBe(false);
  });

  it("formats files that still exist", async () => {
    const dir = makeTempDir("alive.go");
    const config = resolve({
      profile: "standard",
      commands: { format: { ".go": "gofumpt -w {file}" } },
    });
    const { calls, run } = stubRun();

    const outcome = await formatFile(run, config, "alive.go", { cwd: dir });

    expect(outcome.skipped).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("converts a failure into a ghost skip when the file vanishes mid-format (TOCTOU)", async () => {
    const dir = makeTempDir("flaky.go");
    const config = resolve({
      profile: "standard",
      commands: { format: { ".go": "gofumpt -w {file}" } },
    });
    // The file exists at probe time, then vanishes before the formatter
    // reports: re-probe must excuse the ghost, not fail the gate.
    const run: RunCommand = async (_command, _options) => {
      rmSync(join(dir, "flaky.go"));
      return { stdout: "", stderr: "some error", exitCode: 2, timedOut: false };
    };

    const outcome = await formatFile(run, config, "flaky.go", { cwd: dir });

    expect(outcome.skipped).toBe(true);
    expect(outcome.reason).toContain("no longer exists");
    expect(isFormatFailure(outcome)).toBe(false);
  });
});
