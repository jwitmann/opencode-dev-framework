import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  changeProfile,
  dfIgnore,
  parseIgnoreArgs,
  parseIgnoreToolInput,
  verifyGate,
} from "../src/core/commands";
import { clearConfigCache, resolveConfig } from "../src/core/config";
import type { RunCommand } from "../src/core/host";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "odf-commands-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * Substantive review body (plan 17 §3): over both floors with no
 * template markers. Checkbox bodies like "reviewed" now fail.
 */
const REVIEW_BODY =
  "Scope: src/a.ts changed to fix the completion gate test fixture. " +
  "Findings: style-enforcer reported no violations on the changed file; " +
  "test-grounder confirmed the new test fails without the change and passes with it; " +
  "code-reviewer found no correctness defects; pattern-guardian confirmed no new abstractions. " +
  "Resolution: all findings addressed and the gate suite is green.";

describe("changeProfile helper", () => {
  it("edits the profile key in the config file", async () => {
    await writeFile(
      join(dir, ".opencode-dev-framework.yml"),
      "profile: standard\n\nprotect:\n  - .env\n",
    );
    clearConfigCache();
    const message = await changeProfile(dir, "strict");
    expect(message).toContain('profile set to "strict"');
    const content = await readFile(join(dir, ".opencode-dev-framework.yml"), "utf8");
    expect(content).toContain("profile: strict");
    // Original content preserved (text edit, not re-serialize).
    expect(content).toContain("protect:");
  });

  it("creates the config file when missing", async () => {
    const message = await changeProfile(dir, "advisory");
    expect(message).toContain('profile set to "advisory"');
    const content = await readFile(join(dir, ".dev-framework.yml"), "utf8");
    expect(content).toContain("profile: advisory");
    expect(existsSync(join(dir, ".opencode-dev-framework.yml"))).toBe(false);
  });

  it("edits a legacy config in place instead of shadowing it", async () => {
    await writeFile(join(dir, ".opencode-dev-framework.yml"), "profile: standard\n");
    clearConfigCache();
    const message = await changeProfile(dir, "strict");
    expect(message).toContain('profile set to "strict"');
    const content = await readFile(join(dir, ".opencode-dev-framework.yml"), "utf8");
    expect(content).toContain("profile: strict");
    expect(existsSync(join(dir, ".dev-framework.yml"))).toBe(false);
  });
});

describe("verifyGate helper", () => {
  it("runs the gate and reports success", async () => {
    const config = resolveConfig(
      { profile: "standard", commands: { test: "echo ok" } },
      join(dir, ".opencode-dev-framework.yml"),
    );
    const run: RunCommand = async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
    const { report, summary } = await verifyGate(run, dir, config);
    expect(report.ok).toBe(true);
    expect(summary).toContain("completion gate");
  });

  it("reports failure when a command exits non-zero", async () => {
    const config = resolveConfig(
      { profile: "standard", commands: { test: "exit 1" }, gate: { skip_unchanged: false } },
      join(dir, ".opencode-dev-framework.yml"),
    );
    const run: RunCommand = async () => ({
      stdout: "",
      stderr: "boom",
      exitCode: 1,
      timedOut: false,
    });
    const { report } = await verifyGate(run, dir, config);
    expect(report.ok).toBe(false);
  });

  it("returns a PASS verdict with the stable first line when green and reviewed", async () => {
    await mkdir(join(dir, ".opencode", "opencode-dev-framework"), { recursive: true });
    await writeFile(join(dir, ".opencode", "opencode-dev-framework", "review.md"), REVIEW_BODY);
    const config = resolveConfig(
      { profile: "standard", commands: { typecheck: "echo ok" }, gate: { run_tests: false } },
      join(dir, ".opencode-dev-framework.yml"),
    );
    const run: RunCommand = async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
    const { verdict, summary } = await verifyGate(run, dir, config, ["src/a.ts"]);
    expect(verdict).toBe("PASS");
    expect(summary.startsWith("DEV_FRAMEWORK_VERDICT: PASS")).toBe(true);
    expect(summary).toContain("completion gate passed");
  });

  it("returns FAIL when review is required but missing", async () => {
    const config = resolveConfig(
      { profile: "standard", commands: { typecheck: "echo ok" }, gate: { run_tests: false } },
      join(dir, ".opencode-dev-framework.yml"),
    );
    const run: RunCommand = async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
    const { verdict, summary } = await verifyGate(run, dir, config, ["src/a.ts"]);
    expect(verdict).toBe("FAIL");
    expect(summary.startsWith("DEV_FRAMEWORK_VERDICT: FAIL")).toBe(true);
    expect(summary).toContain("peer-review loop has not run");
  });

  it("returns FAIL when a command fails even though review exists", async () => {
    await mkdir(join(dir, ".opencode", "opencode-dev-framework"), { recursive: true });
    await writeFile(join(dir, ".opencode", "opencode-dev-framework", "review.md"), REVIEW_BODY);
    const config = resolveConfig(
      { profile: "standard", commands: { typecheck: "exit 1" }, gate: { run_tests: false } },
      join(dir, ".opencode-dev-framework.yml"),
    );
    const run: RunCommand = async () => ({
      stdout: "",
      stderr: "boom",
      exitCode: 1,
      timedOut: false,
    });
    const { verdict, summary } = await verifyGate(run, dir, config, ["src/a.ts"]);
    expect(verdict).toBe("FAIL");
    expect(summary).toContain("typecheck: failed");
  });

  it("reports raw FAIL in advisory (no blocking language, no PASS conversion)", async () => {
    const config = resolveConfig(
      { profile: "advisory", commands: { typecheck: "exit 1" }, gate: { run_tests: false } },
      join(dir, ".opencode-dev-framework.yml"),
    );
    const run: RunCommand = async () => ({
      stdout: "",
      stderr: "boom",
      exitCode: 1,
      timedOut: false,
    });
    const { verdict, summary } = await verifyGate(run, dir, config, ["src/a.ts"]);
    expect(verdict).toBe("FAIL");
    expect(summary.startsWith("DEV_FRAMEWORK_VERDICT: FAIL")).toBe(true);
  });

  it("unions git-discovered files with the tracker snapshot", async () => {
    const config = resolveConfig(
      { profile: "standard", commands: { typecheck: "true", test: "true" } },
      join(dir, ".opencode-dev-framework.yml"),
    );
    const run: RunCommand = async (command) => {
      if (command[0] === "git")
        return { stdout: "?? src/new.ts\n", stderr: "", exitCode: 0, timedOut: false };
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    };
    const { inspection, report } = await verifyGate(run, dir, config, []);
    // Tracker was empty, but git discovery found the new file and ran the gate.
    expect(inspection.changedFiles).toEqual(["src/new.ts"]);
    expect(report.steps.some((s) => s.name === "typecheck" && !s.skipped)).toBe(true);
  });

  it("does not mutate the caller's changed-file snapshot", async () => {
    const config = resolveConfig(
      { profile: "standard", commands: { typecheck: "echo ok" }, gate: { run_tests: false } },
      join(dir, ".opencode-dev-framework.yml"),
    );
    const run: RunCommand = async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
    const snapshot = ["src/a.ts"];
    await verifyGate(run, dir, config, snapshot);
    expect(snapshot).toEqual(["src/a.ts"]);
  });
});

describe("parseIgnoreArgs", () => {
  it("parses bare patterns", () => {
    expect(parseIgnoreArgs("scratch/** *.local")).toEqual({
      patterns: ["scratch/**", "*.local"],
      store: false,
      list: false,
      remove: [],
    });
  });

  it("accepts flags anywhere and quotes", () => {
    expect(parseIgnoreArgs('-s "my dir/**" -l')).toEqual({
      patterns: ["my dir/**"],
      store: true,
      list: true,
      remove: [],
    });
  });

  it("routes tokens after -r to removals", () => {
    expect(parseIgnoreArgs("a/** -r b/** c/**")).toEqual({
      patterns: ["a/**"],
      store: false,
      list: false,
      remove: ["b/**", "c/**"],
    });
  });

  it("ends flag parsing at --", () => {
    expect(parseIgnoreArgs("-- -s")).toEqual({
      patterns: ["-s"],
      store: false,
      list: false,
      remove: [],
    });
  });

  it("throws a readable error on unknown flags", () => {
    expect(() => parseIgnoreArgs("--frobnicate x")).toThrowError(/Unknown \/df-ignore flag/);
  });

  it("parses empty input as a bare list", () => {
    expect(parseIgnoreArgs("")).toEqual({ patterns: [], store: false, list: false, remove: [] });
  });
});

describe("parseIgnoreToolInput", () => {
  it("normalizes omitted fields once for both adapters", () => {
    expect(parseIgnoreToolInput({ patterns: ["scratch/**"], store: true })).toEqual({
      ok: true,
      args: {
        patterns: ["scratch/**"],
        store: true,
        list: false,
        remove: [],
      },
    });
  });

  it("returns field-level errors instead of throwing", () => {
    const result = parseIgnoreToolInput({ remove: ["valid/**", 42] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Invalid dev_framework_ignore input");
      expect(result.error).toContain("remove.1");
    }
  });
});

describe("dfIgnore helper", () => {
  function standardConfig() {
    return resolveConfig(
      { profile: "standard", gate: { ignore: ["stored/**"] } },
      join(dir, ".opencode-dev-framework.yml"),
    );
  }

  it("adds patterns to the session in place and notes session scope", async () => {
    const session: string[] = ["old/**"];
    const result = await dfIgnore(dir, session, standardConfig(), {
      patterns: ["scratch/**"],
      store: false,
      list: false,
      remove: [],
    });
    expect(session).toEqual(["old/**", "scratch/**"]);
    expect(result.added).toEqual(["scratch/**"]);
    expect(result.message).toContain("Session-scoped only");
  });

  it("dedupes already-present patterns", async () => {
    const session: string[] = ["scratch/**"];
    const result = await dfIgnore(dir, session, standardConfig(), {
      patterns: ["scratch/**"],
      store: false,
      list: false,
      remove: [],
    });
    expect(session).toEqual(["scratch/**"]);
    expect(result.alreadyPresent).toEqual(["scratch/**"]);
  });

  it("removes session patterns and names the missing", async () => {
    const session: string[] = ["a/**", "b/**"];
    const result = await dfIgnore(dir, session, standardConfig(), {
      patterns: [],
      store: false,
      list: false,
      remove: ["a/**", "nope/**"],
    });
    expect(session).toEqual(["b/**"]);
    expect(result.removed).toEqual(["a/**"]);
    expect(result.notFound).toEqual(["nope/**"]);
  });

  it("lists both sources on -l", async () => {
    const result = await dfIgnore(dir, ["s/**"], standardConfig(), {
      patterns: [],
      store: false,
      list: true,
      remove: [],
    });
    expect(result.message).toContain("Session ignores: s/**.");
    expect(result.message).toContain("Config gate.ignore: stored/**.");
  });

  it("lists on a bare invocation", async () => {
    const result = await dfIgnore(dir, [], standardConfig(), {
      patterns: [],
      store: false,
      list: false,
      remove: [],
    });
    expect(result.message).toContain("Session ignores: (none).");
  });

  it("stores new patterns to a created config file", async () => {
    clearConfigCache();
    const config = resolveConfig({ profile: "standard" }, join(dir, ".dev-framework.yml"));
    const session: string[] = [];
    const result = await dfIgnore(dir, session, config, {
      patterns: ["scratch/**"],
      store: true,
      list: false,
      remove: [],
    });
    expect(result.stored).toEqual(["scratch/**"]);
    expect(session).toEqual(["scratch/**"]);
    const stored = await readFile(join(dir, ".dev-framework.yml"), "utf8");
    expect(stored).toContain("gate_ignore: scratch/**");
  });
});

describe("dfIgnore store feedback", () => {
  function standardConfig() {
    return resolveConfig({ profile: "standard" }, join(dir, ".opencode-dev-framework.yml"));
  }

  it("reports nothing to store for a bare -s with an empty session", async () => {
    const result = await dfIgnore(dir, [], standardConfig(), {
      patterns: [],
      store: true,
      list: false,
      remove: [],
    });
    expect(result.stored).toEqual([]);
    expect(result.message).toContain("Nothing to store.");
  });

  it("reflects stored patterns in the -l output", async () => {
    clearConfigCache();
    const config = resolveConfig({ profile: "standard" }, join(dir, ".dev-framework.yml"));
    const result = await dfIgnore(dir, [], config, {
      patterns: ["scratch/**"],
      store: true,
      list: true,
      remove: [],
    });
    expect(result.stored).toEqual(["scratch/**"]);
    expect(result.message).toContain("Config gate.ignore: scratch/**.");
  });
});
