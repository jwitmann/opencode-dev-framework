import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBlockStore, createStuckSnapshotStore } from "../src/block-store";
import { resolveConfig } from "../src/config";
import { createChangedFileTracker } from "../src/gate";
import { evaluateCompletion, inspectCompletion, REVIEW_ARTIFACT_REL } from "../src/harness";
import type { CommandResult, RunCommand } from "../src/host";
import type { LogFn, LogLevel } from "../src/logger";
import type { Config } from "../src/types";
import { diffWeakening, snapshotEnforceable } from "../src/weakening";

function resolve(raw: Config) {
  return resolveConfig(raw, "/project/.opencode-dev-framework.yml");
}

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

describe("snapshotEnforceable / diffWeakening", () => {
  const FULL = {
    profile: "standard",
    commands: { typecheck: "tsc --noEmit", test: "npm test" },
    gate: {
      acceptance: [{ name: "e2e", command: "npm run e2e" }],
      require_review: true,
    },
    preflight: ["read ARCHITECTURE.md", "list tests"],
  } satisfies Config;

  it("reports nothing for an unchanged contract", () => {
    const config = resolve(FULL);
    expect(diffWeakening(snapshotEnforceable(config), config)).toEqual([]);
  });

  it("flags each disabled enforcement flag", () => {
    const before = snapshotEnforceable(resolve(FULL));
    const after = resolve({
      ...FULL,
      gate: { run_typecheck: false, run_tests: false, lint_changed: false, require_review: false },
    });
    const lines = diffWeakening(before, after);
    expect(lines).toContain("run_typecheck was disabled (true → false)");
    expect(lines).toContain("run_tests was disabled (true → false)");
    expect(lines).toContain("require_review was dropped (true → false)");
  });

  it("ignores strengthenings", () => {
    const before = snapshotEnforceable(resolve({ profile: "standard" }));
    const after = resolve({ ...FULL });
    expect(diffWeakening(before, after)).toEqual([]);
  });

  it("flags a removed acceptance check but not an edited command", () => {
    const before = snapshotEnforceable(resolve({ ...FULL }));
    const removed = resolve({
      ...FULL,
      gate: { acceptance: [] },
    });
    expect(diffWeakening(before, removed)).toContain('acceptance check "e2e" was removed');

    const edited = resolve({
      ...FULL,
      gate: { acceptance: [{ name: "e2e", command: "npm run e2e-changed" }] },
    });
    expect(diffWeakening(before, edited)).toEqual([]);
  });

  it("flags removed gate commands only while their step still runs", () => {
    const before = snapshotEnforceable(resolve({ ...FULL }));
    const removed = resolve({ profile: "standard" });
    const lines = diffWeakening(before, removed);
    expect(lines).toContain("typecheck command was removed — the typecheck step will now skip");
    expect(lines).toContain("test command was removed — the test step will now skip");

    // Disabling the step too reports just the flag, not the command too.
    const disabled = resolve({
      profile: "standard",
      gate: { run_typecheck: false, run_tests: false, require_review: false },
    });
    const disabledLines = diffWeakening(before, disabled);
    expect(disabledLines).toContain("run_typecheck was disabled (true → false)");
    expect(disabledLines.some((l) => l.includes("command was removed"))).toBe(false);
  });

  it("flags a lowered max_blocks but not a raised one", () => {
    const before = snapshotEnforceable(resolve({ ...FULL }));
    expect(
      diffWeakening(before, resolve({ ...FULL, gate: { ...FULL.gate, max_blocks: 1 } })),
    ).toContain("max_blocks was lowered (3 → 1)");
    expect(
      diffWeakening(before, resolve({ ...FULL, gate: { ...FULL.gate, max_blocks: 9 } })),
    ).toEqual([]);
  });

  it("flags reduced preflight tasks but not added ones", () => {
    const before = snapshotEnforceable(resolve({ ...FULL }));
    expect(
      diffWeakening(before, resolve({ ...FULL, preflight: ["read ARCHITECTURE.md"] })),
    ).toContain("preflight task were reduced (2 → 1)");
    expect(diffWeakening(before, resolve({ ...FULL, preflight: ["a", "b", "c"] }))).toEqual([]);
  });

  it("collapses a profile downgrade to a single line", () => {
    const before = snapshotEnforceable(resolve({ ...FULL }));
    const lines = diffWeakening(before, resolve({ profile: "advisory" }));
    expect(lines).toEqual(["profile was weakened (standard → advisory)"]);
  });

  it("flags nothing when the profile is raised", () => {
    const before = snapshotEnforceable(resolve({ profile: "advisory" }));
    expect(diffWeakening(before, resolve({ ...FULL }))).toEqual([]);
  });

  it("flags scope narrowing only when the test step would now skip", () => {
    const before = snapshotEnforceable(
      resolve({ profile: "standard", commands: { test: "npm test" } }),
    );
    const narrowed = resolve({
      profile: "standard",
      commands: { test: "npm test" },
      gate: { scope: "changed" },
    });
    expect(diffWeakening(before, narrowed)).toContain(
      'scope changed to "changed" with no test_changed command — the test step will now skip',
    );

    const scoped = resolve({
      profile: "standard",
      commands: { test: "npm test", test_changed: "vitest related {files}" },
      gate: { scope: "changed" },
    });
    expect(diffWeakening(before, scoped)).toEqual([]);
  });
});

describe("weakening at the gate", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "df-weakening-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const gitlessPass: (cmd: string[]) => Partial<CommandResult> = (cmd) =>
    cmd[0] === "git" ? { stderr: "not a git repository", exitCode: 128 } : {};

  function makeRunner() {
    const run: RunCommand = async (command) => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      ...gitlessPass(command),
    });
    return run;
  }

  function makeEval(
    beforeRaw: Config,
    afterRaw: Config,
    opts: { profile?: Config["profile"]; withBaseline?: boolean } = {},
  ) {
    const entries: { level: LogLevel; message: string }[] = [];
    const log: LogFn = async (level, message) => {
      entries.push({ level, message });
    };
    const tracker = createChangedFileTracker();
    tracker.add("src/a.ts");
    const config = resolve(afterRaw);
    const baseline =
      opts.withBaseline === false ? undefined : snapshotEnforceable(resolve(beforeRaw));
    return {
      entries,
      deps: {
        run: makeRunner(),
        config,
        directory: dir,
        sessionID: "s1",
        tracker,
        blockCounts: createBlockStore(undefined),
        stuckSnapshots: createStuckSnapshotStore(undefined),
        log,
        baseline,
      },
    };
  }

  const green = {
    profile: "standard",
    commands: { typecheck: "true", test: "true" },
  } as const;

  it("fails inspection with the reductions leading the summary", async () => {
    await mkdir(join(dir, ".opencode", "opencode-dev-framework"), { recursive: true });
    await writeFile(join(dir, REVIEW_ARTIFACT_REL), REVIEW_BODY);
    const { deps } = makeEval(green, {
      profile: "standard",
      commands: { typecheck: "true", test: "true" },
      gate: { require_review: false },
    });
    const inspection = await inspectCompletion({
      run: deps.run,
      config: deps.config,
      directory: deps.directory,
      trackerFiles: ["src/a.ts"],
      baseline: deps.baseline,
    });
    expect(inspection.ok).toBe(false);
    expect(inspection.weakenings).toContain("require_review was dropped (true → false)");
    expect(inspection.summary.indexOf("weakened mid-session")).toBeLessThan(
      inspection.summary.indexOf("completion gate passed"),
    );
  });

  it("blocks in standard with reason weakened even when the live gate is green", async () => {
    await mkdir(join(dir, ".opencode", "opencode-dev-framework"), { recursive: true });
    await writeFile(join(dir, REVIEW_ARTIFACT_REL), REVIEW_BODY);
    const { deps } = makeEval(green, {
      profile: "standard",
      commands: { typecheck: "true", test: "true" },
      gate: { require_review: false },
    });
    const verdict = await evaluateCompletion(deps);
    expect(verdict.decision).toBe("blocked");
    if (verdict.decision === "blocked") {
      expect(verdict.reason).toBe("weakened");
      expect(verdict.summary).toContain("weakened mid-session");
    }
  });

  it("warns and passes in advisory without blocking", async () => {
    await mkdir(join(dir, ".opencode", "opencode-dev-framework"), { recursive: true });
    await writeFile(join(dir, REVIEW_ARTIFACT_REL), REVIEW_BODY);
    // Baseline is standard (green); live is advisory — the profile
    // downgrade collapses to a single line.
    const { deps, entries } = makeEval(green, {
      profile: "advisory",
      commands: { typecheck: "true", test: "true" },
      gate: { require_review: false },
    });
    const verdict = await evaluateCompletion(deps);
    expect(verdict.decision).toBe("pass");
    if (verdict.decision === "pass") {
      expect(verdict.note).toContain("profile was weakened (standard → advisory)");
    }
    expect(entries.some((e) => e.level === "error" && e.message.includes("advisory"))).toBe(true);
  });

  it("passes without a baseline (manual verify evaluates the live contract as-is)", async () => {
    await mkdir(join(dir, ".opencode", "opencode-dev-framework"), { recursive: true });
    await writeFile(join(dir, REVIEW_ARTIFACT_REL), REVIEW_BODY);
    const { deps } = makeEval(
      green,
      {
        profile: "standard",
        commands: { typecheck: "true", test: "true" },
        gate: { require_review: false },
      },
      { withBaseline: false },
    );
    const verdict = await evaluateCompletion(deps);
    expect(verdict.decision).toBe("pass");
  });
});
