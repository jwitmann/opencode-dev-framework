/**
 * Pre/post-flight harness.
 *
 * Two enforcement layers around the agent's work loop, mirroring the original
 * dev-framework's `preToolUse` deny and `agentStop` gate primitives:
 *
 * - **Pre-flight** (optional, config-gated): when `preflight:` tasks are
 *   configured, edit tools are denied (standard/strict) until the agent has
 *   written the pre-flight artifact. This is a true hard gate: it runs in
 *   `tool.execute.before`, before the edit lands. This is the only fully hard
 *   enforcement available on OpenCode builds without a `session.stopping`
 *   hook.
 * - **Post-flight**: the completion verdict runner. It unions event-tracked
 *   changed files with `git status --porcelain` (robust against event-shape
 *   mismatches), runs the command gate, and — when `gate.require_review` is
 *   set — requires a peer-review artifact for sessions that changed files.
 *   The verdict is consumed by both the `session.stopping` hook (hard stop,
 *   when the OpenCode build supports it) and the `session.idle` fallback
 *   (re-prompt).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BlockStore } from "./block-store.js";
import { runGate, summarizeGate, type ChangedFileTracker, type GateReport } from "./gate.js";
import type { RunCommand } from "./host.js";
import type { LogFn } from "./logger.js";
import type { ResolvedConfig } from "./types.js";

/** Project-relative path of the peer-review artifact the agent must produce. */
export const REVIEW_ARTIFACT_REL = ".opencode/opencode-dev-framework/review.md";

/** Project-relative path of the pre-flight artifact the agent must produce. */
export const PREFLIGHT_ARTIFACT_REL = ".opencode/opencode-dev-framework/preflight.md";

export type ArtifactState = "missing" | "empty" | "present";

/**
 * Inspect an artifact file: present (non-trivial content), empty, or missing.
 * Never throws — unreadable files count as missing.
 */
export async function artifactState(directory: string, relPath: string): Promise<ArtifactState> {
  try {
    const content = await readFile(join(directory, relPath), "utf8");
    return content.trim() === "" ? "empty" : "present";
  } catch {
    return "missing";
  }
}

/**
 * Parse `git status --porcelain=v1` output into repo-relative changed paths.
 * Handles renames (`R  old -> new` — keeps the new path) and dedupes.
 */
export function parseGitStatusPorcelain(stdout: string): string[] {
  const files = new Set<string>();
  for (const line of stdout.split("\n")) {
    if (line.length < 4) continue;
    const status = line.slice(0, 2);
    if (status === "!!") continue; // ignored files are never "changed"
    if (status === "??") {
      // untracked: path starts at column 3
      const p = line.slice(3).trim();
      if (p !== "") files.add(p);
      continue;
    }
    let path = line.slice(3);
    const arrow = path.indexOf(" -> ");
    if (arrow !== -1) path = path.slice(arrow + 4);
    path = path.trim().replace(/^"|"$/g, "");
    if (path !== "") files.add(path);
  }
  return [...files].sort();
}

/**
 * List changed files via git. Returns an empty list when the directory is not
 * a git work tree or git is unavailable — the event tracker remains the
 * primary source in that case.
 */
export async function gitChangedFiles(run: RunCommand, cwd: string): Promise<string[]> {
  const result = await run(["git", "status", "--porcelain=v1", "--untracked-files=normal"], {
    cwd,
  });
  if (result.timedOut || result.exitCode !== 0) return [];
  return parseGitStatusPorcelain(result.stdout);
}

/** Union of tracker and git changed files, sorted and deduped. */
export function mergeChangedFiles(trackerFiles: string[], gitFiles: string[]): string[] {
  return [...new Set([...trackerFiles, ...gitFiles])].sort();
}

/**
 * Decide whether a pre-flight config blocks a tool call. Returns the denial
 * reason, or null when the call is allowed. The artifact path itself is
 * always writable so the agent can produce the artifact; read-only tools are
 * never blocked.
 *
 * Blocking only applies to standard/strict; advisory callers should treat a
 * non-null reason as a warning instead of a denial.
 */
export function preflightBlockReason(
  config: ResolvedConfig,
  toolName: string,
  targetFile: string | undefined,
  artifact: ArtifactState,
): string | null {
  if (config.preflight.length === 0) return null;
  if (config.profile === "off") return null;
  if (artifact === "present") return null;
  const FILE_TOOLS = new Set(["edit", "write", "patch"]);
  if (!FILE_TOOLS.has(toolName)) return null;
  if (targetFile !== undefined && targetFile.replace(/^\.\//, "") === PREFLIGHT_ARTIFACT_REL) {
    return null;
  }
  const tasks = config.preflight.map((t, i) => `${i + 1}. ${t}`).join("\n");
  return (
    `opencode-dev-framework pre-flight check is not complete. Before editing product code, ` +
    `complete the following pre-flight tasks and write your findings to ${PREFLIGHT_ARTIFACT_REL}:\n\n` +
    `${tasks}\n\n` +
    `Read-only tools (read/grep/glob/bash for inspection) remain available. ` +
    `This block lifts automatically once the artifact exists.`
  );
}

// ---------------------------------------------------------------------------
// Completion verdict runner
// ---------------------------------------------------------------------------

export type CompletionVerdict =
  | { decision: "pass"; changedFiles: string[]; note?: string }
  | {
      decision: "blocked";
      reason: "gate" | "review";
      summary: string;
      blockCount: number;
      maxBlocks: number;
      changedFiles: string[];
    }
  | { decision: "standdown"; reason: "gate" | "review"; summary: string; changedFiles: string[] };

export interface CompletionDeps {
  run: RunCommand;
  config: ResolvedConfig;
  directory: string;
  sessionID: string;
  tracker: ChangedFileTracker;
  blockCounts: BlockStore;
  log: LogFn;
}

function reviewMissingMessage(changedFiles: string[]): string {
  const files = changedFiles.map((f) => `  - ${f}`).join("\n");
  return (
    `opencode-dev-framework completion gate — the peer-review loop has not run. ` +
    `This session changed files:\n${files}\n\n` +
    `Per the delegation rule (40-delegation), before declaring done you must run the review ` +
    `cadence: style-enforcer on the changed files, then test-grounder (evidence: tests that ` +
    `fail without the change, commands that actually pass), and code-reviewer / pattern-guardian ` +
    `for correctness and drift. Resolve every blocking finding, then write a summary of the ` +
    `review findings and their resolution to ${REVIEW_ARTIFACT_REL}.\n\n` +
    `Investigation-only reviewers: do not ask them to edit product code.`
  );
}

/**
 * Evaluate the completion gate + review requirement and update block state.
 * Pure orchestration: both the `session.stopping` and `session.idle` call
 * sites feed their outcome from here so one session's block count applies to
 * either hook.
 */
export async function evaluateCompletion(deps: CompletionDeps): Promise<CompletionVerdict> {
  const { run, config, directory, sessionID, tracker, blockCounts } = deps;

  if (config.profile === "off" || !config.gate) {
    return { decision: "pass", changedFiles: [] };
  }

  const trackerFiles = tracker.getChangedFiles();
  const gitFiles = await gitChangedFiles(run, directory);
  const changedFiles = mergeChangedFiles(trackerFiles, gitFiles);

  if (config.gate.skip_unchanged && changedFiles.length === 0) {
    return { decision: "pass", changedFiles, note: "completion gate skipped: no changed files" };
  }

  const report: GateReport = await runGate(run, config, changedFiles, { cwd: directory });
  const gateFailed = report.ran && !report.ok;

  const reviewRequired = config.gate.require_review && changedFiles.length > 0;
  const reviewState = reviewRequired
    ? await artifactState(directory, REVIEW_ARTIFACT_REL)
    : "present";
  const reviewMissing = reviewRequired && reviewState !== "present";

  if (!gateFailed && !reviewMissing) {
    tracker.clearChangedFiles();
    await blockCounts.clear(sessionID);
    return {
      decision: "pass",
      changedFiles,
      note: report.ran ? `completion gate passed\n${summarizeGate(report)}` : undefined,
    };
  }

  // Advisory: report loudly, never block.
  if (!config.gate.block_on_failure) {
    const summary = gateFailed ? summarizeGate(report) : reviewMissingMessage(changedFiles);
    await deps.log("error", `completion gate (advisory — not blocking) saw problems:\n${summary}`);
    return {
      decision: "pass",
      changedFiles,
      note: `completion gate (advisory — not blocking) saw problems:\n${summary}`,
    };
  }

  const reason: "gate" | "review" = gateFailed ? "gate" : "review";
  const summary = gateFailed ? summarizeGate(report) : reviewMissingMessage(changedFiles);
  const maxBlocks = config.gate.max_blocks ?? 3;
  const blockCount = await blockCounts.increment(sessionID);

  if (blockCount > maxBlocks) {
    tracker.clearChangedFiles();
    await blockCounts.clear(sessionID);
    const standdownSummary =
      `opencode-dev-framework completion gate has blocked ${maxBlocks} times and is standing ` +
      `down to avoid trapping you. The requirement is STILL unmet:\n\n${summary}\n\n` +
      `Do not claim the work is complete. Tell the user plainly what remains unmet and why.`;
    await deps.log("error", standdownSummary, { reason, sessionID });
    return { decision: "standdown", reason, summary: standdownSummary, changedFiles };
  }

  await deps.log("error", summary, { reason, sessionID, blockCount, maxBlocks });
  return {
    decision: "blocked",
    reason,
    summary: `${summary}\n\n(Block ${blockCount}/${maxBlocks} this session.)`,
    blockCount,
    maxBlocks,
    changedFiles,
  };
}
