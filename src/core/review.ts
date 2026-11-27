/**
 * Review substance (plan 17 §3).
 *
 * `artifactState()` accepts any non-empty file, so a five-word
 * "looks good" checkboxes the `require_review` duty without doing
 * it. These are the framework's contract for what counts as a
 * review: long enough to hold scope, findings, and resolutions,
 * with no leftover template scaffolding.
 *
 * Thresholds stay constants in code with tests, not user config —
 * "what counts as a review" is a framework contract, not a
 * per-project preference. Deliberate padding (`ok ok ok …` to the
 * floor) is out of scope: nothing here stops deliberate sabotage,
 * it only puts checkboxing on the record for honest-but-eager
 * agents.
 *
 * Freshness (plan 18) sits beside substance: a substantive review of
 * the *wrong task* fails as `stale` unless it names every file this
 * session changed. Same out-of-scope line — deliberate misnaming
 * (naming files without reviewing them) is sabotage, not eagerness.
 *
 * The artifact path is an alias of `REVIEW_ARTIFACT_REL` from the shared
 * paths module (`paths.ts`), the single owner — no cycle, no second spelling.
 */
import { REVIEW_ARTIFACT_REL } from "./paths.js";

const REVIEW_REL = REVIEW_ARTIFACT_REL;

/** Trimmed-character floor for a substantive review. */
export const REVIEW_MIN_CHARS = 200;

/** Whitespace-separated-token floor for a substantive review. */
export const REVIEW_MIN_WORDS = 30;

/**
 * Universal placeholder markers — editing conventions, not
 * per-project vocabulary, so a single hardcoded list is safe.
 * Short tokens use word boundaries so ordinary prose never trips
 * them; all matched case-insensitively against the raw content.
 */
const TEMPLATE_PATTERNS = [
  /\btodo\b/i,
  /\btbd\b/i,
  /\bfixme\b/i,
  /\bxxx\b/i,
  /lorem ipsum/i,
  // Scaffolding-shaped uses only: ordinary meta-vocabulary such as
  // "an empty placeholder file" is a finding, not an unfinished template.
  /^[ \t]*(?:[-*+]\s+)?[A-Za-z][\w -]*:[ \t]*(?:placeholder\b|<\s*placeholder\s*>)[ \t]*$/im,
  /^[ \t]*(?:[-*+]\s+)?placeholder\s*:/im,
  /^[ \t]*(?:[-*+]\s+)?<\s*placeholder\s*>[ \t]*$/im,
  /^[ \t]*(?:[-*+]\s+)?placeholder\s+(?:text|content|scope|findings?|resolutions?|summary)\b/im,
  /\[insert/i,
  /to be (filled|completed|determined)/i,
  /\bfill in\b/i,
  /unfilled/i,
];

/** Review artifact state with substance gradations. */
export type ReviewState = "missing" | "empty" | "thin" | "template" | "stale" | "present";

/** Independently detectable freshness defects for one artifact snapshot. */
export interface ReviewFreshnessIssues {
  uncovered: string[];
  predatesChanges: boolean;
}

/** Primary state plus every meaningful secondary issue found in one read. */
export interface ReviewArtifactAssessment extends ReviewFreshnessIssues {
  state: ReviewState;
}

/** Trimmed-character and word floors, independent of template markers. */
export function hasReviewSubstance(content: string): boolean {
  const trimmed = content.trim();
  const words = trimmed === "" ? 0 : trimmed.split(/\s+/).length;
  return trimmed.length >= REVIEW_MIN_CHARS && words >= REVIEW_MIN_WORDS;
}

/**
 * Assess already-read review content. Pure. Order matters: empty,
 * then template markers (a short file with TODOs reports the more
 * actionable reason), then length floors.
 */
export function assessReviewContent(content: string): Exclude<ReviewState, "missing"> {
  if (content.trim() === "") return "empty";
  if (TEMPLATE_PATTERNS.some((pattern) => pattern.test(content))) return "template";
  // Unfilled checklist scaffolding with nothing checked off.
  if (/\[ \]/.test(content) && !/\[[xX]\]/.test(content)) return "template";
  if (!hasReviewSubstance(content)) return "thin";
  return "present";
}

/** Guidance appended to thin/template/stale summaries: what to write. */
function reviewCadenceReminder(): string {
  return (
    `Before declaring done you must run the project's peer-review cadence: ` +
    `style-enforcer on the changed files, then test-grounder (evidence: tests that ` +
    `fail without the change, commands that actually pass), and code-reviewer / pattern-guardian ` +
    `for correctness and drift. Resolve every blocking finding, then write a summary of the ` +
    `review findings and their resolution to ${REVIEW_REL}.\n\n` +
    `Scope the battery to the change: product code gets the full battery above. ` +
    `Docs-only changes (no product code) get markdown lint instead of specialists — ` +
    `run lint:md on the changed files and record scope plus result in the review. ` +
    `That is the entire docs cadence.\n\n` +
    `Do not re-run a specialist whose scope has not changed since its last report — ` +
    `reuse that report and only re-run what your fixes invalidate.\n\n` +
    `Investigation-only reviewers: do not ask them to edit product code.`
  );
}

export function thinReviewMessage(changedFiles: string[]): string {
  const files = changedFiles.map((f) => `  - ${f}`).join("\n");
  return (
    `opencode-dev-framework completion gate — the peer-review artifact exists but has no ` +
    `substance (under ${REVIEW_MIN_CHARS} characters / ${REVIEW_MIN_WORDS} words). ` +
    `A checkbox note is not a review. This session changed files:\n${files}\n\n` +
    `Rewrite ${REVIEW_REL} fresh for THIS session's changes — scope, findings, ` +
    `and resolutions, in your own words.\n\n` +
    reviewCadenceReminder()
  );
}

function freshnessProblems(issues: ReviewFreshnessIssues): string[] {
  const problems: string[] = [];
  if (issues.uncovered.length > 0) {
    const missing = issues.uncovered.map((file) => `  - ${file}`).join("\n");
    problems.push(`it does not cover this session's changes. Not mentioned:\n${missing}`);
  }
  if (issues.predatesChanges) {
    problems.push(
      "it was not written after the latest session changes, or its freshness could not be established.",
    );
  }
  return problems;
}

export function templateReviewMessage(
  changedFiles: string[],
  issues?: ReviewFreshnessIssues,
): string {
  const files = changedFiles.map((f) => `  - ${f}`).join("\n");
  const problems = issues === undefined ? [] : freshnessProblems(issues);
  const beforeFiles =
    problems.length === 0
      ? " This session changed files:\n"
      : `\n\nAdditional artifact problems:\n${problems
          .map((problem) => `- ${problem}`)
          .join("\n")}\n\nThis session changed files:\n`;
  return (
    `opencode-dev-framework completion gate — the peer-review artifact still contains ` +
    `template placeholders or an unfilled checklist. Finish the review before declaring ` +
    `done.${beforeFiles}${files}\n\n` +
    `Rewrite ${REVIEW_REL} fresh for THIS session's changes — scope, findings, ` +
    `and resolutions, with every placeholder replaced by real findings.\n\n` +
    reviewCadenceReminder()
  );
}

/**
 * Escape a literal for embedding in a RegExp.
 */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Normalize a changed-file entry to the repo-relative `/`-separated form
 * reviews are matched against. Tracker and git entries already arrive
 * repo-relative; absolute entries under the project still match by
 * relativizing, and separators normalize so Windows-style paths match.
 */
export function normalizeReviewPath(file: string, directory: string): string {
  let rel = file;
  if (
    rel.startsWith(directory) &&
    (rel[directory.length] === "/" || rel[directory.length] === "\\")
  ) {
    rel = rel.slice(directory.length + 1);
  }
  return rel.replace(/\\/g, "/");
}

/**
 * Changed files the review text does not cover (plan 18). A file counts as
 * covered when the review names it — relative or absolute (absolute paths
 * contain the relative form). Boundary-guarded so `b-a.ts` does not cover
 * `a.ts` and `a.tsx` does not cover `a.ts`. Pure.
 */
export function findUncoveredFiles(content: string, files: string[]): string[] {
  return files.filter((file) => {
    const pattern = new RegExp(`(?<![\\w-])${escapeRegExp(file)}(?![\\w-])`);
    return !pattern.test(content);
  });
}

export function staleReviewMessage(
  changedFiles: string[],
  uncovered: string[],
  predatesChanges = uncovered.length === 0,
): string {
  const files = changedFiles.map((f) => `  - ${f}`).join("\n");
  const problems = freshnessProblems({ uncovered, predatesChanges });
  const reason =
    problems.length > 0
      ? `${problems.join("\n\n")}\n\n`
      : "it was not written after the latest session changes, or its freshness could not be established.\n\n";
  return (
    `opencode-dev-framework completion gate — the peer-review artifact is substantive ` +
    `but stale: ${reason}` +
    `This session changed files:\n${files}\n\n` +
    `Rewrite ${REVIEW_REL} fresh for THIS session's changes — scope, findings, ` +
    `and resolutions, naming every file above.\n\n` +
    reviewCadenceReminder()
  );
}
