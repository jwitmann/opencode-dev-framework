import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config";
import { createChangedFileTracker } from "../src/gate";
import {
  artifactState,
  evaluateCompletion,
  gitChangedFiles,
  mergeChangedFiles,
  PREFLIGHT_ARTIFACT_REL,
  preflightBlockReason,
  REVIEW_ARTIFACT_REL,
} from "../src/harness";
import type { CommandResult, RunCommand, RunCommandOptions } from "../src/host";
import type { LogFn, LogLevel } from "../src/logger";
import type { Config } from "../src/types";

function resolve(raw: Config) {
  return resolveConfig(raw, "/project/.opencode-dev-framework.yml");
}

interface RunCall {
  command: string[];
  options?: RunCommandOptions;
}

/** Stubbed runner; `resultFor` customizes results per command. */
function stubRun(resultFor: (command: string[]) => Partial<CommandResult> = () => ({})) {
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

const NO_GIT = () => ({ stderr: "not a git repository", exitCode: 128 });

/** Default stub: git fails (no work tree), everything else passes. */
const GITLESS_PASS = (cmd: string[]) => (cmd[0] === "git" ? NO_GIT() : {});

/** Stub where the `false` binary fails (mimics /bin/false). */
const FAIL_FALSE = (cmd: string[]) => {
  if (cmd[0] === "git") return NO_GIT();
  if (cmd[0] === "false") return { exitCode: 1 };
  return {};
};

describe("artifactState", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "df-harness-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports missing for absent files", async () => {
    expect(await artifactState(dir, "nope.md")).toBe("missing");
  });

  it("reports empty for blank files", async () => {
    await writeFile(join(dir, "blank.md"), "  \n");
    expect(await artifactState(dir, "blank.md")).toBe("empty");
  });

  it("reports present for non-trivial files", async () => {
    await writeFile(join(dir, "full.md"), "findings here");
    expect(await artifactState(dir, "full.md")).toBe("present");
  });
});

describe("parseGitStatusPorcelain (via gitChangedFiles)", () => {
  it("parses modified, staged, untracked, and renamed entries", async () => {
    const { run } = stubRun((cmd) =>
      cmd[0] === "git"
        ? {
            stdout: [
              " M src/a.ts",
              "M  src/b.ts",
              "A  src/c.ts",
              "?? src/new.ts",
              "R  old/name.ts -> src/renamed.ts",
              "!! ignored.tmp",
            ].join("\n"),
          }
        : NO_GIT(),
    );
    const files = await gitChangedFiles(run, "/project");
    expect(files).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/new.ts", "src/renamed.ts"]);
  });

  it("returns empty when git fails (not a work tree)", async () => {
    const { run } = stubRun(NO_GIT);
    expect(await gitChangedFiles(run, "/project")).toEqual([]);
  });

  it("unions and dedupes tracker and git files", () => {
    expect(mergeChangedFiles(["b.ts", "a.ts"], ["c.ts", "a.ts"])).toEqual(["a.ts", "b.ts", "c.ts"]);
  });
});

describe("preflightBlockReason", () => {
  const config = resolve({ preflight: ["Task one", "Task two"] });

  it("blocks edit tools when the artifact is missing", () => {
    const reason = preflightBlockReason(config, "edit", "src/a.ts", "missing");
    expect(reason).toContain("pre-flight check is not complete");
    expect(reason).toContain("1. Task one");
    expect(reason).toContain(PREFLIGHT_ARTIFACT_REL);
  });

  it("blocks when the artifact is empty", () => {
    expect(preflightBlockReason(config, "write", "src/a.ts", "empty")).not.toBeNull();
  });

  it("allows edit tools once the artifact is present", () => {
    expect(preflightBlockReason(config, "edit", "src/a.ts", "present")).toBeNull();
  });

  it("always allows writing the artifact itself", () => {
    expect(preflightBlockReason(config, "write", PREFLIGHT_ARTIFACT_REL, "missing")).toBeNull();
  });

  it("never blocks read-only tools", () => {
    for (const tool of ["read", "grep", "glob", "bash", "task"]) {
      expect(preflightBlockReason(config, tool, undefined, "missing")).toBeNull();
    }
  });

  it("is disabled when no preflight tasks are configured", () => {
    const bare = resolve({});
    expect(bare.preflight).toEqual([]);
    expect(preflightBlockReason(bare, "edit", "src/a.ts", "missing")).toBeNull();
  });

  it("is disabled in the off profile", () => {
    const off = resolve({ profile: "off", preflight: ["Task one"] });
    expect(preflightBlockReason(off, "edit", "src/a.ts", "missing")).toBeNull();
  });
});

describe("evaluateCompletion", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "df-harness-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const writeArtifact = async (rel: string, content = "done") => {
    await mkdir(join(dir, ".opencode", "opencode-dev-framework"), { recursive: true });
    await writeFile(join(dir, rel), content);
  };

  function makeDeps(
    raw: Config,
    opts: {
      resultFor?: (command: string[]) => Partial<CommandResult>;
      trackerFiles?: string[];
      sessionID?: string;
    } = {},
  ) {
    const { run } = stubRun(opts.resultFor ?? GITLESS_PASS);
    const { entries, log } = stubLog();
    const tracker = createChangedFileTracker();
    for (const f of opts.trackerFiles ?? []) tracker.add(f);
    const blockCounts = new Map<string, number>();
    const config = resolve(raw);
    const deps = {
      run,
      config,
      directory: dir,
      sessionID: opts.sessionID ?? "s1",
      tracker,
      blockCounts,
      log,
    };
    return { deps, entries, tracker, blockCounts };
  }

  it("passes with no changed files (skip_unchanged) even without a review artifact", async () => {
    const { deps, entries } = makeDeps({ profile: "standard" });
    const verdict = await evaluateCompletion(deps);
    expect(verdict.decision).toBe("pass");
    expect(verdict.note).toContain("no changed files");
    expect(entries).toHaveLength(0);
  });

  it("passes when the gate is green and the review artifact exists", async () => {
    await writeArtifact(REVIEW_ARTIFACT_REL);
    const { deps, tracker, blockCounts } = makeDeps(
      {
        profile: "standard",
        commands: { typecheck: "true", test: "true" },
      },
      { trackerFiles: ["src/a.ts"] },
    );
    const verdict = await evaluateCompletion(deps);
    expect(verdict.decision).toBe("pass");
    expect(tracker.getChangedFiles()).toEqual([]);
    expect(blockCounts.size).toBe(0);
  });

  it("blocks (reason=review) when files changed but the review artifact is missing", async () => {
    const { deps, blockCounts } = makeDeps(
      { profile: "standard", commands: { typecheck: "true", test: "true" } },
      { trackerFiles: ["src/a.ts"] },
    );
    const verdict = await evaluateCompletion(deps);
    expect(verdict.decision).toBe("blocked");
    if (verdict.decision === "blocked") {
      expect(verdict.reason).toBe("review");
      expect(verdict.summary).toContain("peer-review loop has not run");
      expect(verdict.blockCount).toBe(1);
    }
    expect(blockCounts.get("s1")).toBe(1);
  });

  it("blocks (reason=gate) on failing checks even when the review artifact exists", async () => {
    await writeArtifact(REVIEW_ARTIFACT_REL);
    const { deps } = makeDeps(
      {
        profile: "standard",
        commands: { typecheck: "false", test: "true" },
      },
      { trackerFiles: ["src/a.ts"], resultFor: FAIL_FALSE },
    );
    const verdict = await evaluateCompletion(deps);
    expect(verdict.decision).toBe("blocked");
    if (verdict.decision === "blocked") expect(verdict.reason).toBe("gate");
  });

  it("detects changed files from git when the event tracker is empty", async () => {
    const { deps } = makeDeps(
      { profile: "standard", commands: { typecheck: "true", test: "true" } },
      {
        resultFor: (cmd) =>
          cmd[0] === "git"
            ? { stdout: " M src/from-git.ts\n" }
            : cmd.join(" ") === "true"
              ? {}
              : { exitCode: 1 },
      },
    );
    const verdict = await evaluateCompletion(deps);
    expect(verdict.decision).toBe("blocked");
    if (verdict.decision === "blocked") {
      expect(verdict.changedFiles).toEqual(["src/from-git.ts"]);
    }
  });

  it("counts blocks per session and stands down after max_blocks", async () => {
    const raw: Config = {
      profile: "standard",
      commands: { typecheck: "false", test: "true" },
      gate: { max_blocks: 2 },
    };
    const first = makeDeps(raw, {
      trackerFiles: ["src/a.ts"],
      sessionID: "sess",
      resultFor: FAIL_FALSE,
    });
    const v1 = await evaluateCompletion(first.deps);
    expect(v1.decision).toBe("blocked");
    expect(first.blockCounts.get("sess")).toBe(1);

    const second = makeDeps(raw, {
      trackerFiles: ["src/a.ts"],
      sessionID: "sess",
      resultFor: FAIL_FALSE,
    });
    second.blockCounts.set("sess", 1); // continue the same session's count
    const v2 = await evaluateCompletion(second.deps);
    expect(v2.decision).toBe("blocked");
    expect(second.blockCounts.get("sess")).toBe(2);

    const third = makeDeps(raw, {
      trackerFiles: ["src/a.ts"],
      sessionID: "sess",
      resultFor: FAIL_FALSE,
    });
    third.blockCounts.set("sess", 2);
    const v3 = await evaluateCompletion(third.deps);
    expect(v3.decision).toBe("standdown");
    if (v3.decision === "standdown") {
      expect(v3.summary).toContain("standing down");
      expect(v3.summary).toContain("Do not claim the work is complete");
    }
    // standdown resets state
    expect(third.blockCounts.size).toBe(0);
    expect(third.tracker.getChangedFiles()).toEqual([]);
  });

  it("advisory never blocks: reports loudly and passes", async () => {
    const { deps, entries } = makeDeps(
      { profile: "advisory", commands: { typecheck: "false", test: "true" } },
      { trackerFiles: ["src/a.ts"], resultFor: FAIL_FALSE },
    );
    const verdict = await evaluateCompletion(deps);
    expect(verdict.decision).toBe("pass");
    expect(verdict.note).toContain("advisory");
    expect(entries.some((e) => e.level === "error")).toBe(true);
  });

  it("advisory also reports the missing review artifact without blocking", async () => {
    const { deps } = makeDeps(
      { profile: "advisory", commands: { typecheck: "true", test: "true" } },
      { trackerFiles: ["src/a.ts"] },
    );
    const verdict = await evaluateCompletion(deps);
    expect(verdict.decision).toBe("pass");
    expect(verdict.note).toContain("peer-review loop has not run");
  });

  it("off profile always passes without running anything", async () => {
    const { deps, entries } = makeDeps(
      { profile: "off", commands: { typecheck: "false", test: "false" } },
      { trackerFiles: ["src/a.ts"] },
    );
    const verdict = await evaluateCompletion(deps);
    expect(verdict.decision).toBe("pass");
    expect(entries).toHaveLength(0);
  });

  it("gate.require_review: false disables the review requirement", async () => {
    const { deps } = makeDeps(
      {
        profile: "standard",
        commands: { typecheck: "true", test: "true" },
        gate: { require_review: false },
      },
      { trackerFiles: ["src/a.ts"] },
    );
    const verdict = await evaluateCompletion(deps);
    expect(verdict.decision).toBe("pass");
  });
});
