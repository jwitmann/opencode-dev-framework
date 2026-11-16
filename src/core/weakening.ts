import { normalizeCommandMap } from "./command-utils.js";
import type { Profile, ResolvedConfig } from "./types.js";

/**
 * Config-weakening detection (plan 17 §2).
 *
 * The duties document (`.opencode-dev-framework.yml`) is freely rewritable
 * mid-session and reloads on mtime — deleting checks, dropping
 * `require_review`, or lowering `max_blocks` silently moves the goalposts.
 * Rewriting the duties to make them pass is the canonical duty-escape, so
 * the session-start contract is snapshotted and any mid-session reduction
 * is surfaced in the gate summary. Detection, not prevention: edits stay
 * allowed (agent-driven flows like `df init` must keep working); the gate
 * just refuses to pass a weakened contract silently.
 *
 * Only monotonic weakenings are flagged (removed checks, disabled flags,
 * lowered budgets). Command *modifications* (`npm test` → `vitest run`)
 * are ambiguous — possibly a legitimate toolchain fix — and are left
 * unflagged by design; see the limitation note on `diffWeakening`.
 */

const PROFILE_STRICTNESS: Record<Profile, number> = {
  off: 0,
  advisory: 1,
  standard: 2,
  strict: 3,
};

/** Enforceable subset of the resolved config, snapshotted at session start. */
export interface EnforceableSnapshot {
  profile: Profile;
  runTypecheck: boolean;
  runTests: boolean;
  lintChanged: boolean;
  requireReview: boolean;
  blockOnFailure: boolean;
  scope: "all" | "changed";
  maxBlocks: number;
  hasTypecheck: boolean;
  hasTest: boolean;
  hasTestChanged: boolean;
  hasLint: boolean;
  /** Acceptance check name → command. */
  acceptance: Record<string, string>;
  preflightCount: number;
}

/** Project the enforceable subset out of a resolved config. Pure. */
export function snapshotEnforceable(config: ResolvedConfig): EnforceableSnapshot {
  const { default: defaultLint, byExtension } = normalizeCommandMap(config.commands.lint);
  return {
    profile: config.profile,
    runTypecheck: config.gate.run_typecheck,
    runTests: config.gate.run_tests,
    lintChanged: config.gate.lint_changed,
    requireReview: config.gate.require_review,
    blockOnFailure: config.gate.block_on_failure,
    scope: config.gate.scope,
    maxBlocks: config.gate.max_blocks,
    hasTypecheck: config.commands.typecheck !== undefined,
    hasTest: config.commands.test !== undefined,
    hasTestChanged: config.commands.test_changed !== undefined,
    hasLint: defaultLint !== undefined || Object.keys(byExtension).length > 0,
    acceptance: Object.fromEntries(config.gate.acceptance.map((c) => [c.name, c.command])),
    preflightCount: config.preflight.length,
  };
}

function hasLintNow(config: ResolvedConfig): boolean {
  const { default: defaultLint, byExtension } = normalizeCommandMap(config.commands.lint);
  return defaultLint !== undefined || Object.keys(byExtension).length > 0;
}

/**
 * Diff a session-start snapshot against the live config, returning one
 * human-readable line per duty reduction. Empty means the contract is
 * intact (or was only strengthened). Pure.
 *
 * Deliberate limitations:
 * - Command *modifications* are not flagged — only removals. A changed
 *   command string cannot be judged statically.
 * - Acceptance command edits for a retained name are not flagged, for
 *   the same reason; only removed names are.
 * - A weakened profile reports as a single profile line; field-level
 *   cascades (e.g. `block_on_failure` flipping with the profile
 *   default) are suppressed as noise.
 */
export function diffWeakening(before: EnforceableSnapshot, after: ResolvedConfig): string[] {
  if (PROFILE_STRICTNESS[after.profile] < PROFILE_STRICTNESS[before.profile]) {
    return [`profile was weakened (${before.profile} → ${after.profile})`];
  }

  const lines: string[] = [];
  const flag = (was: boolean, is: boolean, label: string) => {
    if (was && !is) lines.push(`${label} was disabled (true → false)`);
  };

  flag(before.runTypecheck, after.gate.run_typecheck, "run_typecheck");
  flag(before.runTests, after.gate.run_tests, "run_tests");
  flag(before.lintChanged, after.gate.lint_changed, "lint_changed");
  if (before.requireReview && !after.gate.require_review) {
    lines.push("require_review was dropped (true → false)");
  }
  flag(before.blockOnFailure, after.gate.block_on_failure, "block_on_failure");

  if (
    before.scope === "all" &&
    after.gate.scope === "changed" &&
    after.commands.test_changed === undefined
  ) {
    lines.push(
      'scope changed to "changed" with no test_changed command — the test step will now skip',
    );
  }

  if (after.gate.max_blocks < before.maxBlocks) {
    lines.push(`max_blocks was lowered (${before.maxBlocks} → ${after.gate.max_blocks})`);
  }

  if (after.gate.run_typecheck && before.hasTypecheck && after.commands.typecheck === undefined) {
    lines.push("typecheck command was removed — the typecheck step will now skip");
  }
  if (after.gate.run_tests) {
    if (
      after.gate.scope === "changed" &&
      before.hasTestChanged &&
      after.commands.test_changed === undefined
    ) {
      lines.push("test_changed command was removed — the test step will now skip");
    } else if (
      after.gate.scope !== "changed" &&
      before.hasTest &&
      after.commands.test === undefined
    ) {
      lines.push("test command was removed — the test step will now skip");
    }
  }
  if (after.gate.lint_changed && before.hasLint && !hasLintNow(after)) {
    lines.push("lint commands were removed — changed-file lint will now skip");
  }

  const afterNames = new Set(after.gate.acceptance.map((c) => c.name));
  for (const name of Object.keys(before.acceptance)) {
    if (!afterNames.has(name)) {
      lines.push(`acceptance check "${name}" was removed`);
    }
  }

  if (after.preflight.length < before.preflightCount) {
    const taskWord = before.preflightCount - after.preflight.length === 1 ? "task" : "tasks";
    lines.push(
      `preflight ${taskWord} were reduced (${before.preflightCount} → ${after.preflight.length})`,
    );
  }

  return lines;
}
