/**
 * `/df-goal`: verified-goal wrapper around native `/goal`.
 *
 * A thin adapter, not a second goal engine: it validates that verified-goal
 * mode is meaningful and available (§3.3), appends the framework verification
 * addendum to the user's objective verbatim (§3.2), and delegates exactly
 * once to native `/goal` via `session.command`. Native `/goal` keeps owning
 * kickoff, state, reviewer, pause/resume/clear, and continuations; the
 * framework's idle gate stays the independent deterministic backstop.
 *
 * All policy here is pure (input -> data, no session I/O): `src/index.ts`
 * owns the `ctx.command.transform` registration, the `command.list()`
 * call, and the delegation call; the shape-tolerant listing predicate
 * (`isNativeGoalListed`) lives here. Unit tests drive these functions
 * with a stub delegate.
 */

import { hasMeaningfulChecks } from "./config.js";
import type { ResolvedConfig } from "./types.js";

/**
 * Native `/goal` objective limit. Counts JS `text.length` (UTF-16 code
 * units) — confirmed by the Phase 0 spike against core `goal.ts`
 * (`MAX_OBJECTIVE = 4_000`), not bytes or grapheme clusters.
 */
export const NATIVE_GOAL_LIMIT = 4000;

/**
 * Verification addendum appended to the objective (plan §3.2). The addendum
 * length in limit accounting is computed from this exact string at
 * delegation time, never from a hardcoded constant.
 */
export const VERIFICATION_ADDENDUM = `Verification contract added by opencode-dev-framework:

Before declaring this goal complete, run dev_framework_verify after your final changes. A FAIL result means the goal is incomplete: fix the underlying cause and run verification again. Any later edit invalidates an earlier verification result. PASS is required but does not replace the original objective or its acceptance criteria. Do not disable, skip, or weaken the configured checks to obtain PASS.`;

/** Separator between the verbatim objective and the addendum. */
const OBJECTIVE_SEPARATOR = "\n\n";

export type GoalBuildResult =
  | { ok: true; text: string; alreadyWrapped: boolean }
  | { ok: false; error: string };

/**
 * Append the verification addendum to the objective without rewriting the
 * user's text. An objective that already contains the addendum is used
 * verbatim (never double-wrapped on retry). The complete string counts
 * toward the native limit; overflow is rejected with lengths, never
 * silently truncated.
 */
export function buildVerifiedObjective(objective: string): GoalBuildResult {
  if (objective.trim().length === 0) {
    return {
      ok: false,
      error:
        "Cannot start a verified goal: the objective is empty. " +
        "Provide an objective, e.g. /df-goal <objective>.",
    };
  }
  if (objective.includes(VERIFICATION_ADDENDUM)) {
    // Already wrapped (e.g. a retry of wrapper output): idempotent, but the
    // combined text still counts toward the native limit. Report the single
    // combined length — the addendum is inside, not additive.
    if (objective.length > NATIVE_GOAL_LIMIT) {
      return {
        ok: false,
        error:
          `Cannot start a verified goal: objective including the previously appended ` +
          `verification addendum is ${objective.length} characters, exceeding the native ` +
          `/goal limit of ${NATIVE_GOAL_LIMIT} characters. Shorten the objective by at ` +
          `least ${objective.length - NATIVE_GOAL_LIMIT} characters; the addendum is never truncated.`,
      };
    }
    return { ok: true, text: objective, alreadyWrapped: true };
  }
  const text = `${objective}${OBJECTIVE_SEPARATOR}${VERIFICATION_ADDENDUM}`;
  // Same unit native uses: JS string length (UTF-16 code units).
  if (text.length > NATIVE_GOAL_LIMIT) {
    return {
      ok: false,
      error:
        `Cannot start a verified goal: objective is ${objective.length} characters, ` +
        `the verification addendum adds ${VERIFICATION_ADDENDUM.length} characters plus a ` +
        `blank-line separator, total ${text.length} exceeds the native /goal limit of ` +
        `${NATIVE_GOAL_LIMIT} characters. ` +
        `Shorten the objective; the addendum is never truncated.`,
    };
  }
  return { ok: true, text, alreadyWrapped: false };
}

export type GoalAvailability = { ok: true } | { ok: false; error: string };

/**
 * Availability/profile/meaningful-check rules (plan §3.3). `/df-goal` means
 * verified goal, not an alias for `/goal`: every failure names the exact
 * cause and points at the alternatives (enable a blocking profile or use
 * native `/goal` directly for an unverified objective).
 */
export function checkGoalAvailability(
  config: ResolvedConfig,
  nativeGoalAvailable: boolean,
): GoalAvailability {
  if (!nativeGoalAvailable) {
    return {
      ok: false,
      error:
        "Cannot start a verified goal: native /goal is not available on this core. " +
        "Upgrade OpenCode to a build containing native /goal, or run the objective " +
        "without verification where native /goal exists.",
    };
  }
  if (config.profile === "off") {
    return {
      ok: false,
      error:
        'Cannot start a verified goal: profile is "off", so verification would be vacuous. ' +
        "Enable a blocking profile (standard or strict), or use native /goal directly " +
        "for an unverified objective.",
    };
  }
  if (!config.gate?.block_on_failure) {
    const found = config.gate?.block_on_failure;
    return {
      ok: false,
      error:
        `Cannot start a verified goal: gate.block_on_failure is ${String(found)}, ` +
        "but /df-goal requires it to be true. Advisory mode must not gain a blocking " +
        "side channel through /df-goal. Enable a blocking profile (standard or strict), " +
        "or use native /goal directly.",
    };
  }
  if (!hasMeaningfulChecks(config)) {
    return {
      ok: false,
      error:
        "Cannot start a verified goal: the resolved configuration provides no meaningful " +
        "completion check (no typecheck/test command, no changed-file lint, no acceptance " +
        "commands, and no review requirement). Configure at least one check, or use native " +
        "/goal directly for a purely semantic objective.",
    };
  }
  return { ok: true };
}

/** Single delegation call to native `/goal` (flat core protocol shape). */
export type GoalDelegate = (args: {
  sessionID: string;
  name: string;
  text: string;
}) => Promise<unknown>;

export interface RunGoalDeps {
  config: ResolvedConfig;
  /** Raw objective text from the command invocation. */
  objective: string;
  sessionID: string;
  nativeGoalAvailable: boolean;
  delegate: GoalDelegate;
}

export type RunGoalResult =
  | { delegated: true; text: string; alreadyWrapped: boolean }
  | { delegated: false; error: string };

/**
 * Validate, wrap, and delegate exactly once. Native delegation errors
 * propagate untouched — never an unverified fallback. The wrapper itself
 * admits no kickoff synthetic message.
 */
export async function runGoalCommand(deps: RunGoalDeps): Promise<RunGoalResult> {
  const availability = checkGoalAvailability(deps.config, deps.nativeGoalAvailable);
  if (!availability.ok) {
    return { delegated: false, error: availability.error };
  }
  const built = buildVerifiedObjective(deps.objective);
  if (!built.ok) {
    return { delegated: false, error: built.error };
  }
  await deps.delegate({ sessionID: deps.sessionID, name: "goal", text: built.text });
  return { delegated: true, text: built.text, alreadyWrapped: built.alreadyWrapped };
}

/**
 * Extract the raw objective from a command invocation prompt. The
 * invocation prompt is a `Prompt` struct (`{ text, ... }`); accept a bare
 * string defensively and fall back to empty (rejected downstream as an
 * empty objective) for anything else.
 */
export function extractObjectiveText(prompt: unknown): string {
  if (typeof prompt === "string") return prompt;
  if (prompt !== null && typeof prompt === "object") {
    const text = (prompt as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
}

/**
 * Capability probe over `command.list()` output: true when an entry named
 * `goal` is present. The real output shape is `{ location, data: [...] }`
 * (`CommandListOutput`); a bare array is tolerated for forward
 * compatibility. Defensive throughout (SDK codegen drifts; core is truth) —
 * anything unrecognized means unavailable, never an assumed capability.
 */
export function isNativeGoalListed(listed: unknown): boolean {
  const entries = unwrapCommandEntries(listed);
  if (entries === null) return false;
  return entries.some(
    (entry) =>
      entry !== null && typeof entry === "object" && (entry as { name?: unknown }).name === "goal",
  );
}

function unwrapCommandEntries(listed: unknown): unknown[] | null {
  if (Array.isArray(listed)) return listed;
  if (listed !== null && typeof listed === "object") {
    const data = (listed as { data?: unknown }).data;
    if (Array.isArray(data)) return data;
  }
  return null;
}
