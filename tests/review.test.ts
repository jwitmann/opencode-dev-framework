import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBlockStore, createStuckSnapshotStore } from "../src/block-store";
import { resolveConfig } from "../src/config";
import { createChangedFileTracker } from "../src/gate";
import { evaluateCompletion, inspectCompletion, REVIEW_ARTIFACT_REL } from "../src/harness";
import type { CommandResult, RunCommand } from "../src/host";
import type { LogFn, LogLevel } from "../src/logger";
import {
  assessReviewContent,
  REVIEW_MIN_CHARS,
  REVIEW_MIN_WORDS,
  templateReviewMessage,
  thinReviewMessage,
} from "../src/review";
import type { Config } from "../src/types";

function resolve(raw: Config) {
  return resolveConfig(raw, "/project/.opencode-dev-framework.yml");
}

const REVIEW_BODY =
  "Scope: src/a.ts changed to fix the completion gate test fixture. " +
  "Findings: style-enforcer reported no violations on the changed file; " +
  "test-grounder confirmed the new test fails without the change and passes with it; " +
  "code-reviewer found no correctness defects; pattern-guardian confirmed no new abstractions. " +
  "Resolution: all findings addressed and the gate suite is green.";

describe("assessReviewContent", () => {
  it("reports empty for blank content", () => {
    expect(assessReviewContent("  \n")).toBe("empty");
  });

  it("reports thin for checkbox notes", () => {
    expect(assessReviewContent("looks good")).toBe("thin");
    expect(assessReviewContent("done")).toBe("thin");
    expect(assessReviewContent("reviewed")).toBe("thin");
  });

  it("reports thin when either floor is missed", () => {
    // Long single token: chars pass, words fail.
    expect(assessReviewContent(`${"a".repeat(REVIEW_MIN_CHARS + 50)}`)).toBe("thin");
    // Many tiny words: words pass, chars fail.
    expect(
      assessReviewContent(
        Array(REVIEW_MIN_WORDS + 5)
          .fill("ok")
          .join(" "),
      ),
    ).toBe("thin");
  });

  it("reports present for a substantive review", () => {
    expect(REVIEW_BODY.length).toBeGreaterThan(REVIEW_MIN_CHARS);
    expect(assessReviewContent(REVIEW_BODY)).toBe("present");
  });

  it("reports template for placeholder markers even in long content", () => {
    expect(assessReviewContent(`${REVIEW_BODY} TODO: double-check the edge case`)).toBe("template");
    expect(assessReviewContent(`${REVIEW_BODY} TBD on the second finding`)).toBe("template");
    expect(assessReviewContent(`${REVIEW_BODY} FIXME later`)).toBe("template");
  });

  it("reports template for an unfilled checklist", () => {
    const checklist =
      "- [ ] scope reviewed in depth and breadth across the changed files\n" +
      "- [ ] findings recorded with evidence and resolutions for each one\n" +
      "- [ ] resolutions verified by re-running the full gate suite until green\n" +
      "filler ".repeat(20);
    expect(assessReviewContent(checklist)).toBe("template");
  });

  it("reports present for a checked checklist with substance", () => {
    const checked = `${REVIEW_BODY}\n- [x] scope\n- [x] findings\n- [x] resolutions`;
    expect(assessReviewContent(checked)).toBe("present");
  });

  it("pins the message contracts", () => {
    expect(thinReviewMessage(["src/a.ts"])).toContain(`${REVIEW_MIN_CHARS}`);
    expect(thinReviewMessage(["src/a.ts"])).toContain("has no substance");
    expect(templateReviewMessage(["src/a.ts"])).toContain("placeholders");
    // Constitution-agnostic: no citation of bundled rule text that a
    // superseded constitution may not contain.
    expect(thinReviewMessage(["src/a.ts"])).not.toContain("40-delegation");
    expect(templateReviewMessage(["src/a.ts"])).not.toContain("40-delegation");
  });
});

describe("review substance at the gate", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "df-review-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function stubRun(resultFor: (command: string[]) => Partial<CommandResult> = () => ({})) {
    const run: RunCommand = async (command) => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      ...resultFor(command),
    });
    return { run };
  }

  const GITLESS_PASS = (cmd: string[]) =>
    cmd[0] === "git" ? { stderr: "not a git repository", exitCode: 128 } : {};

  function makeDeps(raw: Config) {
    const { run } = stubRun(GITLESS_PASS);
    const entries: { level: LogLevel; message: string }[] = [];
    const log: LogFn = async (level, message) => {
      entries.push({ level, message });
    };
    const tracker = createChangedFileTracker();
    tracker.add("src/a.ts");
    return {
      entries,
      deps: {
        run,
        config: resolve(raw),
        directory: dir,
        sessionID: "s1",
        tracker,
        blockCounts: createBlockStore(undefined),
        stuckSnapshots: createStuckSnapshotStore(undefined),
        log,
      },
    };
  }

  async function writeReview(content: string) {
    await mkdir(join(dir, ".opencode", "opencode-dev-framework"), { recursive: true });
    await writeFile(join(dir, REVIEW_ARTIFACT_REL), content);
  }

  const GREEN = {
    profile: "standard",
    commands: { typecheck: "true", test: "true" },
  } as const;

  it("blocks a thin review with reason review", async () => {
    await writeReview("looks good");
    const { deps } = makeDeps(GREEN);
    const verdict = await evaluateCompletion(deps);
    expect(verdict.decision).toBe("blocked");
    if (verdict.decision === "blocked") {
      expect(verdict.reason).toBe("review");
      expect(verdict.summary).toContain("has no substance");
    }
  });

  it("blocks a template review and names placeholders", async () => {
    await writeReview(`${REVIEW_BODY} TODO: verify the edge case`);
    const { deps } = makeDeps(GREEN);
    const inspection = await inspectCompletion({
      run: deps.run,
      config: deps.config,
      directory: deps.directory,
      trackerFiles: ["src/a.ts"],
    });
    expect(inspection.ok).toBe(false);
    expect(inspection.reviewState).toBe("template");
    expect(inspection.summary).toContain("placeholders");
  });

  it("passes a substantive review", async () => {
    await writeReview(REVIEW_BODY);
    const { deps } = makeDeps(GREEN);
    expect((await evaluateCompletion(deps)).decision).toBe("pass");
  });

  it("warns and passes on thin reviews in advisory", async () => {
    await writeReview("looks good");
    const { deps, entries } = makeDeps({ ...GREEN, profile: "advisory" });
    const verdict = await evaluateCompletion(deps);
    expect(verdict.decision).toBe("pass");
    if (verdict.decision === "pass") {
      expect(verdict.note).toContain("has no substance");
    }
    expect(entries.some((e) => e.level === "error" && e.message.includes("advisory"))).toBe(true);
  });

  it("tracks thin and missing as distinct stuck signatures", async () => {
    // Two identical missing evaluations: one investigate cycle tolerated.
    const first = makeDeps(GREEN);
    expect((await evaluateCompletion(first.deps)).decision).toBe("blocked");
    expect((await evaluateCompletion(first.deps)).decision).toBe("blocked");
    expect((await first.deps.stuckSnapshots.get("s1"))?.repeats).toBe(1);

    // Progress (a thin review where none existed) resets the streak even
    // though the verdict is still blocked.
    await writeReview("looks good");
    const second = makeDeps(GREEN);
    second.deps.blockCounts = first.deps.blockCounts;
    second.deps.stuckSnapshots = first.deps.stuckSnapshots;
    expect((await evaluateCompletion(second.deps)).decision).toBe("blocked");
    expect((await second.deps.stuckSnapshots.get("s1"))?.repeats).toBe(0);
  });
});
