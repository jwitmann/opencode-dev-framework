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
 *   enforcement — the idle continuation can only steer, never deny.
 * - **Post-flight**: the completion verdict runner. It unions event-tracked
 *   changed files with `git status --porcelain` (robust against event-shape
 *   mismatches), runs the command gate, and — when `gate.require_review` is
 *   set — requires a peer-review artifact for sessions that changed files.
 *   The verdict is consumed by the `experimental.idle` hook (same-execution
 *   synthetic continuation) and the `session.idle` event net (re-prompt).
 */

import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, normalize, relative } from "node:path";
import type { BlockStore, StuckSnapshotStore } from "./block-store.js";
import { compileGlobMatchers } from "./command-utils.js";
import { type ChangedFileTracker, type GateReport, runGate, summarizeGate } from "./gate.js";
import type { RunCommand } from "./host.js";
import type { LintLimiter } from "./lint.js";
import type { LogFn } from "./logger.js";
import {
  LEGACY_PREFLIGHT_ARTIFACT_REL,
  LEGACY_REVIEW_ARTIFACT_REL,
  PREFLIGHT_ARTIFACT_REL,
  REVIEW_ARTIFACT_REL,
  REVIEW_RELS,
  RUNTIME_STATUS_RELS,
} from "./paths.js";
import {
  assessReviewContent,
  findUncoveredFiles,
  hasReviewSubstance,
  normalizeReviewPath,
  type ReviewArtifactAssessment,
  type ReviewState,
  staleReviewMessage,
  templateReviewMessage,
  thinReviewMessage,
} from "./review.js";

// Re-exported so existing import sites keep working: the paths module is
// the single owner, this module the historical home.
export {
  LEGACY_PREFLIGHT_ARTIFACT_REL,
  LEGACY_REVIEW_ARTIFACT_REL,
  PREFLIGHT_ARTIFACT_REL,
  REVIEW_ARTIFACT_REL,
};

import type { ResolvedConfig } from "./types.js";
import { diffWeakening, type EnforceableSnapshot } from "./weakening.js";

/**
 * True when a tool-call target is the review artifact. Normalizes like the
 * guardrail path matcher (absolute paths resolve against the project
 * directory) plus `normalize`, so non-canonical spellings (`a/../b`,
 * `././x`) compare by where they resolve, not how they are spelled.
 * Matches the exact artifact only — never a prefix or a similarly-named
 * file.
 */
export function isReviewArtifact(filePath: string, directory?: string): boolean {
  let candidate = filePath;
  if (directory !== undefined && isAbsolute(filePath)) {
    candidate = relative(directory, filePath);
  }
  return (
    normalize(candidate) === normalize(REVIEW_ARTIFACT_REL) ||
    normalize(candidate) === normalize(LEGACY_REVIEW_ARTIFACT_REL)
  );
}

/**
 * Shared denial text for the child-session artifact guard (plan 23): one
 * spelling, referenced from both enforcement layers so a wording fix can
 * never update one site and miss the other.
 */
export function childArtifactDenial(): string {
  return (
    `child sessions never write ${REVIEW_ARTIFACT_REL}: the review duty belongs ` +
    `to the top-level session — report back as text and let the orchestrator ` +
    `write the artifact`
  );
}

/**
 * Consecutive no-progress repeats before early stand-down (docs/plans/14-stuck-detection.md): the
 * third identical blocked evaluation (two repeats) stands down. One
 * investigate-then-fix cycle — a repeat with no edits while the agent
 * reads logs or runs diagnostics — still blocks. Hardcoded, not a config
 * key: the profile stays the single enforcement axis.
 */
export const NO_PROGRESS_REPEATS = 2;

export type ArtifactState = "missing" | "empty" | "present";

/**
 * Inspect artifact files, new location first: present (non-trivial
 * content), empty, or missing. The first non-missing candidate wins, so
 * an agent mid-migration (both files present) answers from the new one.
 * Never throws — unreadable files count as missing.
 */
export async function artifactStateFirst(
  directory: string,
  rels: readonly string[],
): Promise<ArtifactState> {
  for (const rel of rels) {
    const state = await artifactState(directory, rel);
    if (state !== "missing") {
      return state;
    }
  }
  return "missing";
}

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

/** Selected review artifact content plus the location that supplied it. */
interface ReviewSnapshot {
  content: string;
  rel: string;
}

/**
 * Read the review artifact, new location first. Undefined when neither
 * location is readable — callers report that path as `missing`, never
 * `stale`. Writers always use the new location.
 */
async function readReviewSnapshot(directory: string): Promise<ReviewSnapshot | undefined> {
  for (const rel of REVIEW_RELS) {
    try {
      return { content: await readFile(join(directory, rel), "utf8"), rel };
    } catch {
      // try the next (legacy) location
    }
  }
  return undefined;
}

async function readReviewContent(directory: string): Promise<string | undefined> {
  return (await readReviewSnapshot(directory))?.content;
}

/**
 * A review must be written after the latest existing covered edit. Deleted
 * files have no current mtime, so they retain the filename-coverage check.
 * Unknown stat results fail stale rather than representing unproven ordering
 * as fresh. Equal timestamps pass for coarse-resolution filesystems.
 */
async function reviewPredatesChanges(
  directory: string,
  reviewRel: string,
  changedFiles: string[],
): Promise<boolean> {
  let reviewMtimeMs: number;
  try {
    reviewMtimeMs = (await stat(join(directory, reviewRel))).mtimeMs;
  } catch {
    return true;
  }

  let latestChangeMs: number | undefined;
  for (const file of changedFiles) {
    try {
      const changedMtimeMs = (await stat(join(directory, file))).mtimeMs;
      latestChangeMs = Math.max(latestChangeMs ?? changedMtimeMs, changedMtimeMs);
    } catch (error) {
      if ((error as { code?: unknown })?.code === "ENOENT") continue;
      return true;
    }
  }
  return latestChangeMs !== undefined && reviewMtimeMs < latestChangeMs;
}

/**
 * Grade one artifact snapshot including substance (plan 17 §3) and freshness
 * (plan 18) without losing secondary diagnostics to the primary-state short
 * circuit. A substantive review of the wrong task reports `stale` unless it
 * names every changed file. Never throws — unreadable files count as missing.
 * Substantive template-marked content also receives coverage/freshness checks;
 * thin or empty content gets one concise rewrite request instead of a noisy
 * list of every omitted file.
 */
export async function readReviewAssessment(
  directory: string,
  changedFiles: string[] = [],
): Promise<ReviewArtifactAssessment> {
  const review = await readReviewSnapshot(directory);
  if (review === undefined) {
    return { state: "missing", uncovered: [], predatesChanges: false };
  }
  const substance = assessReviewContent(review.content);
  const checkFreshness =
    substance === "present" || (substance === "template" && hasReviewSubstance(review.content));
  if (!checkFreshness) {
    return { state: substance, uncovered: [], predatesChanges: false };
  }

  const covered = coverableChangedFiles(directory, changedFiles);
  const uncovered = findUncoveredFiles(review.content, covered);
  const predatesChanges =
    covered.length > 0 && (await reviewPredatesChanges(directory, review.rel, covered));
  const state =
    substance !== "present"
      ? substance
      : uncovered.length > 0 || predatesChanges
        ? "stale"
        : "present";
  return { state, uncovered, predatesChanges };
}

/** Preserve the primary-state API for policy and stuck-signature callers. */
export async function readReviewState(
  directory: string,
  changedFiles: string[] = [],
): Promise<ReviewState> {
  return (await readReviewAssessment(directory, changedFiles)).state;
}

/**
 * Files the freshness check covers: everything the session changed except
 * the plugin's own bookkeeping, which the agent did not author — the
 * review artifact itself (always tracked once written; self-reference
 * would be absurd) and the runtime snapshot (plugin-written every
 * continuation; surfaces via git where `.opencode/` is not ignored).
 */
export function coverableChangedFiles(directory: string, changedFiles: string[]): string[] {
  const owned = new Set([
    REVIEW_ARTIFACT_REL,
    LEGACY_REVIEW_ARTIFACT_REL,
    ...RUNTIME_STATUS_RELS.map((rel) => rel),
  ]);
  return changedFiles.map((f) => normalizeReviewPath(f, directory)).filter((f) => !owned.has(f));
}

/**
 * Uncovered files for the stale-review message. Empty when the artifact is
 * unreadable — that path already reports `missing`, never `stale`.
 */
export async function uncoveredReviewFiles(
  directory: string,
  changedFiles: string[],
): Promise<string[]> {
  const content = await readReviewContent(directory);
  if (content === undefined) {
    return [];
  }
  return findUncoveredFiles(content, coverableChangedFiles(directory, changedFiles));
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
 * Match a file path against the gate-ignore patterns: permanent config
 * (`gate.ignore`) plus this session's `/df-ignore` additions. Returns the
 * matching pattern, or undefined. Mirrors `matchExclude` semantics — paths
 * resolve against the project directory, and patterns without a slash also
 * match basenames at any depth. Matchers compile once per pattern array via
 * the shared `compileGlobMatchers` cache, so callers pass the live arrays
 * (never a spread copy) to keep the cache hot.
 */
export function matchGateIgnore(
  config: ResolvedConfig,
  sessionIgnores: readonly string[],
  filePath: string,
  directory?: string,
): string | undefined {
  let candidate = filePath;
  if (directory !== undefined && isAbsolute(filePath)) {
    candidate = relative(directory, filePath);
  }
  candidate = candidate.replace(/^\.\//, "");
  const name = basename(candidate);

  const sources: readonly (readonly string[])[] = [config.gate.ignore, sessionIgnores];
  for (const patterns of sources) {
    for (const { pattern, match } of compileGlobMatchers(patterns)) {
      if (match(candidate)) {
        return pattern;
      }
      if (!pattern.includes("/") && match(name)) {
        return pattern;
      }
    }
  }
  return undefined;
}

/**
 * Drop gate-ignored files from a changed-file list. Applied once at the
 * `inspectCompletion` merge point so ignored files leave the whole gate:
 * command steps, review coverage, and the pass-cache fingerprint all read
 * the filtered list. Session additions and permanent config filter
 * identically — permanence differs, behavior does not.
 */
export function filterGateIgnored(
  config: ResolvedConfig,
  sessionIgnores: readonly string[],
  files: string[],
  directory?: string,
): string[] {
  if (config.gate.ignore.length === 0 && sessionIgnores.length === 0) {
    return files;
  }
  return files.filter((f) => matchGateIgnore(config, sessionIgnores, f, directory) === undefined);
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
  directory?: string,
): string | null {
  if (config.preflight.length === 0) return null;
  if (config.profile === "off") return null;
  if (artifact === "present") return null;
  const FILE_TOOLS = new Set(["edit", "write", "patch"]);
  if (!FILE_TOOLS.has(toolName)) return null;
  // The artifact is always writable so the agent can comply — by
  // project-relative or absolute spelling (mirrors `isReviewArtifact`:
  // compare where the path resolves, not how it is spelled).
  if (targetFile !== undefined) {
    let candidate = targetFile;
    if (directory !== undefined && isAbsolute(targetFile)) {
      candidate = relative(directory, targetFile);
    }
    // Either home keeps the artifact writable (old deployments comply
    // through the legacy path until they converge on the new one).
    if (
      normalize(candidate) === normalize(PREFLIGHT_ARTIFACT_REL) ||
      normalize(candidate) === normalize(LEGACY_PREFLIGHT_ARTIFACT_REL)
    ) {
      return null;
    }
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
      reason: "gate" | "review" | "weakened";
      summary: string;
      blockCount: number;
      maxBlocks: number;
      changedFiles: string[];
    }
  | {
      decision: "standdown";
      reason: "gate" | "review" | "weakened";
      summary: string;
      changedFiles: string[];
    };

export interface CompletionDeps {
  run: RunCommand;
  config: ResolvedConfig;
  directory: string;
  sessionID: string;
  tracker: ChangedFileTracker;
  blockCounts: BlockStore;
  /** Last-blocked-evaluation snapshots for no-progress early stand-down. */
  stuckSnapshots: StuckSnapshotStore;
  log: LogFn;
  /** This session's `/df-ignore` additions (live `HookState.sessionIgnores`). */
  sessionIgnores?: readonly string[];
  /** Shared limiter bounding concurrent linter subprocesses. */
  lintLimiter?: LintLimiter;
  /** Session pass cache; skips redundant gate suites across idle boundaries. */
  passCache?: PassCache;
  /**
   * Session-start enforceable snapshot (plan 17 §2). When present, a
   * mid-session duty reduction blocks in standard/strict (reason
   * `"weakened"`) and warns in advisory. Absent (e.g. manual
   * `/df-verify`), the live contract evaluates as-is.
   */
  baseline?: EnforceableSnapshot;
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
    `Do not re-run a specialist whose scope has not changed since its last report — ` +
    `reuse that report and only re-run what your fixes invalidate.\n\n` +
    `Investigation-only reviewers: do not ask them to edit product code.`
  );
}

/**
 * Side-effect-free inputs for a completion inspection, with one deliberate
 * exception: the session pass-cache write-through (`passCache.key/summary`
 * store on clean runs, clear on failures) when the caller opts in by
 * passing `passCache`. The tracker file list is a read-only snapshot:
 * inspection never clears it, never touches block counts, never logs, and
 * never admits input — those are policy decisions owned by
 * `evaluateCompletion`.
 */
export interface InspectionDeps {
  run: RunCommand;
  config: ResolvedConfig;
  directory: string;
  /** Read-only snapshot of tracker files; never mutated. */
  trackerFiles: string[];
  /**
   * This session's `/df-ignore` additions (live `HookState.sessionIgnores`).
   * Unioned with config `gate.ignore` at the merge point; absent reads as
   * no session additions.
   */
  sessionIgnores?: readonly string[];
  /** Shared limiter bounding concurrent linter subprocesses. */
  lintLimiter?: LintLimiter;
  /**
   * Pass cache owned by the session state. When set and the working tree
   * still matches the last clean pass (same files, same mtimes/sizes,
   * same gate-relevant config, review artifact untouched — modulo the
   * mtime/size same-tick rewrite window), inspection returns the cached
   * pass without spawning any gate command. Any content change, config
   * change, or review removal misses the cache and re-runs. Only
   * genuinely clean passes are stored — advisory problems and failures
   * never are, so loud reporting is preserved.
   */
  passCache?: PassCache;
  /**
   * Session-start enforceable snapshot (plan 17 §2). When present, a
   * mid-session duty reduction fails the inspection (`ok: false`) with
   * the reductions listed in `weakenings` and leading the summary.
   * Absent (e.g. manual `/df-verify`), the live contract evaluates
   * as-is.
   */
  baseline?: EnforceableSnapshot;
}

/**
 * Fingerprint of the last clean pass. `key` is null when nothing is cached;
 * a non-null key with its summary replays the pass verbatim.
 */
export interface PassCache {
  key: string | null;
  summary: string | null;
}

/** Create an empty pass cache (one per session state). */
export function createPassCache(): PassCache {
  return { key: null, summary: null };
}

/**
 * Fingerprint the current tree state for cache comparison. Returns null
 * when any input is unreadable — an unreadable file can never prove the
 * tree unchanged, so null forces a re-run (the safe direction). Covers
 * every live input to `runGate` (commands, gate options, `exclude`) plus
 * the review artifact, so any behavior-changing config edit misses.
 */
async function passCacheKey(
  config: ResolvedConfig,
  directory: string,
  changedFiles: string[],
  reviewRequired: boolean,
): Promise<string | null> {
  const gateConfig = JSON.stringify({
    commands: config.commands,
    gate: config.gate,
    exclude: config.exclude,
  });
  const parts: string[] = [];
  for (const file of [...changedFiles].sort()) {
    try {
      const s = await stat(join(directory, file));
      parts.push(`${file}:${s.mtimeMs}:${s.size}`);
    } catch (error) {
      // A deleted file is known state (gone), not unknown state: finger-
      // print the deletion itself so a clean pass stays cacheable, and so
      // a deletion vs. an empty list never share a key. Any other stat
      // failure still bails — the tree may be unreadable.
      if ((error as { code?: unknown })?.code === "ENOENT") {
        parts.push(`${file}:deleted`);
        continue;
      }
      return null;
    }
  }
  let review = "not-required";
  if (reviewRequired) {
    // Fingerprint BOTH candidate locations, including absence. Content
    // selection is first-readable; tracking only the first stat-able path
    // could fingerprint a directory while a legacy review supplied content,
    // and tracking only the selected path would miss creation of a new-path
    // artifact that takes precedence on the next evaluation.
    const candidates: string[] = [];
    for (const rel of REVIEW_RELS) {
      try {
        const s = await stat(join(directory, rel));
        candidates.push(`${rel}:${s.mtimeMs}:${s.size}`);
      } catch (error) {
        if ((error as { code?: unknown })?.code === "ENOENT") {
          candidates.push(`${rel}:missing`);
          continue;
        }
        // An unknown artifact state cannot support a cached proof.
        return null;
      }
    }
    review = candidates.join("\n");
  }
  return `${gateConfig}\n${parts.join("\n")}\nreview:${review}`;
}

/**
 * Raw completion report. `ok` is the unadjudicated outcome (gate passed,
 * review satisfied, and contract unweakened); profiles, block counting,
 * and stand-down are applied by `evaluateCompletion`, and `verifyGate`
 * reports `ok` verbatim as its PASS/FAIL verdict.
 */
export interface CompletionInspection {
  changedFiles: string[];
  report: GateReport;
  reviewRequired: boolean;
  /** Substance- and freshness-graded review state (plans 17 §3, 18): only `present` satisfies the duty. */
  reviewState: ReviewState;
  reviewMissing: boolean;
  /** True when the gate short-circuited on `skip_unchanged` with no files. */
  skipped: boolean;
  /** Mid-session duty reductions vs the session-start snapshot (empty when intact). */
  weakenings: string[];
  /** Raw outcome: gate ok AND review satisfied AND contract unweakened. No profile/policy applied. */
  ok: boolean;
  /** Human- and transcript-readable summary (gate detail or review notice). */
  summary: string;
}

/** Lead section for a weakened-contract summary; the live gate detail follows. */
export function weakeningSection(weakenings: string[]): string {
  const lines = weakenings.map((w) => `  - ${w}`);
  return (
    `opencode-dev-framework completion contract was weakened mid-session ` +
    `(duties were reduced after the session started):\n${lines.join("\n")}`
  );
}

/**
 * Inspect the current completion state without mutating anything except the
 * opted-in session pass-cache write-through: no tracker clearing, no
 * block-count changes, no logging, no input admitted. Both the idle policy
 * (`evaluateCompletion`) and manual verification (`verifyGate`) read from
 * here so they evaluate the same full contract.
 */
export async function inspectCompletion(deps: InspectionDeps): Promise<CompletionInspection> {
  const { run, config, directory, trackerFiles } = deps;

  const disabled: CompletionInspection = {
    changedFiles: [],
    report: {
      ran: false,
      reason: "completion gate disabled",
      steps: [],
      ok: true,
      failedSteps: [],
    },
    reviewRequired: false,
    reviewState: "present",
    reviewMissing: false,
    skipped: false,
    weakenings: [],
    ok: true,
    summary: "completion gate disabled (profile off or no gate section)",
  };
  if (config.profile === "off" || !config.gate) {
    return disabled;
  }

  const gitFiles = await gitChangedFiles(run, directory);
  // Gate-ignore hotlist: ignored files leave the whole gate — steps, review
  // coverage, and the fingerprint below all read this filtered list.
  const changedFiles = filterGateIgnored(
    config,
    deps.sessionIgnores ?? [],
    mergeChangedFiles(trackerFiles, gitFiles),
    directory,
  );

  if (config.gate.skip_unchanged && changedFiles.length === 0) {
    return {
      ...disabled,
      changedFiles,
      report: { ran: false, reason: "no changed files", steps: [], ok: true, failedSteps: [] },
      skipped: true,
      summary: "completion gate skipped: no changed files",
    };
  }

  const reviewRequired = config.gate.require_review && changedFiles.length > 0;

  // Mid-session duty reduction vs the session-start snapshot. Computed
  // before the pass-cache lookup: the fingerprint does not cover the
  // profile, so a weakened contract must never replay a cached pass.
  // Only evaluated when the gate actually runs — a skipped gate (no
  // changed files) has no duties to escape.
  const weakenings = deps.baseline !== undefined ? diffWeakening(deps.baseline, config) : [];
  const weakened = weakenings.length > 0;

  // Fingerprint the tree the gate is about to validate, once. A hit replays
  // the cached pass; a clean run stores this same pre-run key. Storing the
  // pre-run (not post-run) state matters: an edit landing mid-gate-run
  // changes the stats, so the next idle misses and gates the edit instead
  // of replaying a pass over content the gate never saw.
  const fingerprint =
    deps.passCache !== undefined
      ? await passCacheKey(config, directory, changedFiles, reviewRequired)
      : null;

  // Fast path: the tree still matches the last clean pass — replay it
  // without spawning gate commands. The key covers file identity, content
  // freshness (mtime+size), gate-relevant config, and the review artifact,
  // so any real change misses and re-runs.
  const cachedKey = deps.passCache?.key;
  const cachedSummary = deps.passCache?.summary;
  if (
    cachedKey !== undefined &&
    cachedKey !== null &&
    cachedSummary !== undefined &&
    cachedSummary !== null &&
    !weakened
  ) {
    if (fingerprint !== null && fingerprint === cachedKey) {
      return {
        changedFiles,
        report: { ran: true, steps: [], ok: true, failedSteps: [] },
        reviewRequired,
        reviewState: "present",
        reviewMissing: false,
        skipped: false,
        weakenings,
        ok: true,
        summary: cachedSummary,
      };
    }
  }

  const report: GateReport = await runGate(run, config, changedFiles, {
    cwd: directory,
    lintLimiter: deps.lintLimiter,
  });
  const gateFailed = report.ran && !report.ok;

  const reviewAssessment: ReviewArtifactAssessment = reviewRequired
    ? await readReviewAssessment(directory, changedFiles)
    : { state: "present", uncovered: [], predatesChanges: false };
  const reviewState = reviewAssessment.state;
  const reviewMissing = reviewRequired && reviewState !== "present";

  const ok = !gateFailed && !reviewMissing && !weakened;
  const baseSummary = gateFailed
    ? summarizeGate(report)
    : reviewState === "thin"
      ? thinReviewMessage(changedFiles)
      : reviewState === "template"
        ? templateReviewMessage(changedFiles, reviewAssessment)
        : reviewState === "stale"
          ? staleReviewMessage(
              changedFiles,
              reviewAssessment.uncovered,
              reviewAssessment.predatesChanges,
            )
          : reviewMissing
            ? reviewMissingMessage(changedFiles)
            : report.ran
              ? `completion gate passed\n${summarizeGate(report)}`
              : `completion gate passed (${report.reason ?? "nothing to run"})`;
  const summary = weakened ? `${weakeningSection(weakenings)}\n\n${baseSummary}` : baseSummary;
  if (deps.passCache !== undefined) {
    if (!gateFailed && !reviewMissing && !weakened && report.ran && fingerprint !== null) {
      // Genuinely clean pass that actually ran — store the pre-run
      // fingerprint for the next idle. Advisory problems (gateFailed),
      // missing reviews, and weakened contracts never store; vacuous
      // passes (nothing ran) neither store nor clear.
      deps.passCache.key = fingerprint;
      deps.passCache.summary = summary;
    } else if (gateFailed || reviewMissing || weakened) {
      deps.passCache.key = null;
      deps.passCache.summary = null;
    }
  }
  return {
    changedFiles,
    report,
    reviewRequired,
    reviewState,
    reviewMissing,
    weakenings,
    skipped: false,
    ok,
    summary,
  };
}

/**
 * Evaluate the completion gate + review requirement and update block state.
 * Pure orchestration: both the `experimental.idle` hook and the
 * `session.idle` event net feed their outcome from here so one session's
 * block count applies to either lever.
 */
export async function evaluateCompletion(deps: CompletionDeps): Promise<CompletionVerdict> {
  const { run, config, directory, sessionID, tracker, blockCounts, stuckSnapshots } = deps;

  if (config.profile === "off" || !config.gate) {
    return { decision: "pass", changedFiles: [] };
  }

  const inspection = await inspectCompletion({
    run,
    config,
    directory,
    trackerFiles: tracker.getChangedFiles(),
    sessionIgnores: deps.sessionIgnores ?? [],
    lintLimiter: deps.lintLimiter,
    passCache: deps.passCache,
    baseline: deps.baseline,
  });
  const { changedFiles, report } = inspection;
  const gateFailed = report.ran && !report.ok;
  const reviewMissing = inspection.reviewMissing;
  const weakened = inspection.weakenings.length > 0;

  if (!gateFailed && !reviewMissing && !weakened) {
    tracker.clearChangedFiles();
    await blockCounts.clear(sessionID);
    await stuckSnapshots.clear(sessionID);
    return {
      decision: "pass",
      changedFiles,
      // Preserve the historical note shape: detailed on run, skip note on
      // skip, absent when the gate never ran for any other reason.
      note: report.ran || inspection.skipped ? inspection.summary : undefined,
    };
  }

  // Advisory: report loudly, never block. A weakened contract in advisory
  // lands here too — visible in the log and the pass note, never a block.
  if (!config.gate.block_on_failure) {
    const summary = inspection.summary;
    await deps.log("error", `completion gate (advisory — not blocking) saw problems:\n${summary}`);
    return {
      decision: "pass",
      changedFiles,
      note: `completion gate (advisory — not blocking) saw problems:\n${summary}`,
    };
  }

  // A weakened contract outranks the live gate outcome: the evidence was
  // gathered against moved goalposts, so the verdict names that first.
  const reason: "gate" | "review" | "weakened" = weakened
    ? "weakened"
    : gateFailed
      ? "gate"
      : "review";
  const summary = inspection.summary;
  const maxBlocks = config.gate.max_blocks ?? 3;

  // No-progress early stand-down (docs/plans/14-stuck-detection.md): consecutive blocked
  // evaluations with the identical failure signature and no new edits buy
  // zero information, so stop spending the budget on them. One
  // investigate-then-fix cycle is tolerated (a single repeat still
  // blocks); the third identical evaluation stands down.
  const signature = weakened
    ? `weakened:${[...inspection.weakenings].sort().join("|")}`
    : gateFailed
      ? `gate:${report.failedSteps
          .map((s) => s.name)
          .sort()
          .join(",")}`
      : `review:${inspection.reviewState}`;
  const files = [...changedFiles].sort();
  const previous = await stuckSnapshots.get(sessionID);
  const noProgress =
    previous !== undefined &&
    previous.signature === signature &&
    previous.files.length === files.length &&
    previous.files.every((f, i) => f === files[i]);
  const repeats = noProgress ? previous.repeats + 1 : 0;
  if (repeats >= NO_PROGRESS_REPEATS) {
    tracker.clearChangedFiles();
    await blockCounts.clear(sessionID);
    await stuckSnapshots.clear(sessionID);
    const stuckSummary =
      `opencode-dev-framework completion gate has seen the identical failure across ` +
      `${repeats + 1} evaluations with no new changes and is standing down to avoid ` +
      `trapping you. The requirement is STILL unmet:\n\n${summary}\n\n` +
      `Do not claim the work is complete. Tell the user plainly what remains unmet and why.`;
    await deps.log("error", stuckSummary, { reason, sessionID });
    return { decision: "standdown", reason, summary: stuckSummary, changedFiles };
  }
  await stuckSnapshots.record(sessionID, { signature, files, repeats });

  const blockCount = await blockCounts.increment(sessionID);

  if (blockCount > maxBlocks) {
    tracker.clearChangedFiles();
    await blockCounts.clear(sessionID);
    await stuckSnapshots.clear(sessionID);
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
