/**
 * Shared hook flow: harness-agnostic hook state and the per-edit / gate
 * evaluation flows that every host adapter drives. Host-specific code
 * (opencode `Plugin.define` registration, DSH Cordis bundle wiring) lives
 * in the adapters and calls into these flows with a populated `HookState`.
 *
 * This module was extracted from the OpenCode adapter
 * (`src/adapters/opencode/index.ts`, formerly `src/index.ts`) with
 * relocation only — plus formatter line-breaks, added explicit types, and
 * a `blockCounts` doc comment. No behavior change; the adapter keeps
 * registration thin.
 */

import type { BlockStore, StuckSnapshotStore } from "./block-store.js";
import { clearConfigCache, configMtimeMs, loadConfig } from "./config.js";
import type { ChangedFileTracker } from "./gate.js";
import { type CompletionVerdict, evaluateCompletion, type PassCache } from "./harness.js";
import type { RunCommand } from "./host.js";
import {
  detectPreCommitAvailability,
  isLintFailure,
  type LintLimiter,
  type LintOutcome,
  lintFile,
  summarizeLint,
} from "./lint.js";
import type { LogFn, LogLevel } from "./logger.js";
import { loadConstitution } from "./rules.js";
import { type IdleHookVia, type TemplateState, writeRuntimeStatus } from "./runtime-status.js";
import type { HostSeams, ResolvedConfig } from "./types.js";
import { checkTemplateUpdates, summarizeDrift } from "./update.js";
import type { EnforceableSnapshot } from "./weakening.js";

// ---------------------------------------------------------------------------
// Internal state — single plugin instance per location.directory.
// HookState is kept in module scope, not in a registry keyed by directory,
// because V2 Context is already per-location. The registry map is still
// used for legacy test helpers (buildHooks) that inject a fake directory.
// ---------------------------------------------------------------------------

export interface HookState {
  directory: string;
  config: ResolvedConfig;
  /**
   * Session-start enforceable snapshot (plan 17 §2). Compared against the
   * live config at every gate evaluation so mid-session duty reductions
   * surface in the verdict. Never re-baselined — including across
   * `set_profile` — so a profile downgrade reads as the weakening it is.
   */
  initialEnforceable: EnforceableSnapshot;
  log: LogFn;
  run: RunCommand;
  tracker: ChangedFileTracker;
  constitution: string | null;
  /** Per-session count of completion-gate blocks (keyed by sessionID). */
  blockCounts: Map<string, number>;
  /**
   * Persistent block-count store over `ctx.storage`, write-through into
   * `blockCounts` (which stays the live L1 cache for status rendering).
   * Survives plugin reload / session_move / server restart.
   * Note: this `HookState` is intentionally forked from `registry.ts`
   * `HookState` (module state is per-location here, not registry-keyed);
   * `format-status.ts` reads the `blockCounts` Map projection, which the
   * store keeps live on every get/increment/clear.
   */
  blocks: BlockStore;
  /**
   * Last-blocked-evaluation snapshots for no-progress early stand-down
   * (docs/plans/14-stuck-detection.md). Same storage-backed, best-effort pattern as `blocks`;
   * memory-only here (no status projection needed).
   */
  stuckSnapshots: StuckSnapshotStore;
  precommitAvailable?: boolean;
  configMtime?: number;
  /**
   * Shared FIFO limiter bounding concurrent linter subprocesses across
   * per-edit lints and gate lint steps.
   */
  lintLimiter: LintLimiter;
  /** Fingerprint of the last clean gate pass; skips redundant suites. */
  passCache: PassCache;
  /**
   * Host seam availability (see `HostSeams`), probed once at mount with
   * guarded reads. Rendered by status so a degraded mount reads as
   * degraded, never as silently whole. The DSH adapter probes this at
   * mount; OpenCode leaves it unset (its seams are core-guaranteed).
   * Forked from `registry.ts` `HookState` like the stores above.
   */
  seams?: HostSeams;
  /**
   * `Date.now()` of the last config-mtime check. Hook fires are far more
   * frequent than config edits, so mtime stats are throttled to a 1s window.
   */
  lastConfigCheck: number;
  /**
   * Which lever completed a gate evaluation most recently in this process:
   * `"idle"` once the `experimental.idle` hook has (same-execution
   * continuation active), `"fallback"` when only the `event.subscribe`
   * idle re-prompt net has. Absent until either fires. Memory-only: a
   * reload re-derives it on the next idle boundary. `/df-status` renders
   * the active level.
   */
  continuationLevel?: "idle" | "fallback";
  /**
   * Dedup map for the idle-first cutover: sessionID → `Date.now()` at the
   * last COMPLETED hook evaluation (pass, blocked-admitted, and standdown
   * all stamp; throw/early-return paths do not). The `event.subscribe` idle net
   * skips when the stamp is fresh so one boundary never runs the gate
   * twice. Memory-only; worst case on reload is one extra suite run.
   */
  lastIdleHandled: Map<string, number>;
}

/**
 * Live hook state for stale-hook guards. Private binding — read it via
 * `getActiveState()` (writes go through `setActiveState`), mirroring the
 * `registry.ts` getter/setter idiom. Never exported mutable: an ESM live
 * `let` binding would let any importer assign past the setter.
 */
let activeState: HookState | null = null;
export function getActiveState(): HookState | null {
  return activeState;
}
export function setActiveState(state: HookState | null): void {
  activeState = state;
}

/** Fallback logger before any adapter registers one. Same idiom as above. */
let fallbackLog: LogFn = async () => {};
export function getFallbackLog(): LogFn {
  return fallbackLog;
}
export function setFallbackLog(log: LogFn): void {
  fallbackLog = log;
}

/**
 * Minimum interval between config-mtime checks. Every hook fire calls
 * `reloadConfigIfChanged`, but the config file almost never changes
 * mid-session, so a 1s staleness window is invisible.
 */
const CONFIG_RELOAD_MIN_INTERVAL_MS = 1000;

export function safeLog(
  state: HookState | null,
  level: LogLevel,
  message: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  const fn = state && typeof state.log === "function" ? state.log : fallbackLog;
  return fn(level, message, extra);
}

export async function reloadConfigIfChanged(state: HookState): Promise<void> {
  // Throttle mtime checks: every hook fire calls this, but the config file
  // almost never changes mid-session. A 1s staleness window is invisible.
  const now = Date.now();
  if (now - state.lastConfigCheck < CONFIG_RELOAD_MIN_INTERVAL_MS) {
    return;
  }
  state.lastConfigCheck = now;
  const mtime = configMtimeMs(state.directory);
  if (mtime === undefined) {
    return;
  }
  if (state.configMtime !== undefined && state.configMtime === mtime) {
    return;
  }
  try {
    clearConfigCache();
    const next = loadConfig(state.directory);
    const { constitution } = await loadConstitution(next, state.directory);
    state.config = next;
    state.constitution = constitution;
    state.configMtime = mtime;
  } catch {
    // keep current state on read failure
  }
}

/**
 * Turn a completion verdict into the continuation message fed back to the
 * agent when blocked. Shared by the `experimental.idle` hook (same
 * execution, via synthetic) and the `event.subscribe` idle re-prompt
 * fallback so wording (and block counting) is identical on every
 * enforcement level.
 */
export function continuationMessage(
  verdict: Extract<CompletionVerdict, { decision: "blocked" }>,
): string {
  const why =
    verdict.reason === "review"
      ? "the peer-review requirement is unmet"
      : verdict.reason === "weakened"
        ? "the completion contract was weakened mid-session"
        : "the repo's checks are failing";
  return (
    `opencode-dev-framework completion gate blocked you from finishing because ${why} ` +
    `(block ${verdict.blockCount}/${verdict.maxBlocks}).\n\n${verdict.summary}\n\n` +
    `Fix the underlying cause and continue. Do NOT disable, skip, or weaken these checks to ` +
    `get past the gate. If a failure is pre-existing and unrelated to your work, prove it ` +
    `(show it fails on a clean tree) and report it to the user.\n\n` +
    `You can inspect live gate state with dev_framework_runtime; if the setup ` +
    `looks stale, check drift with dev_framework_update.`
  );
}

/** Log pass/standdown verdicts; returns the continuation message when blocked. */
export async function actOnVerdict(
  state: HookState,
  verdict: CompletionVerdict,
): Promise<string | null> {
  if (verdict.decision === "pass") {
    if (verdict.note) {
      await safeLog(state, "info", verdict.note, { changedFiles: verdict.changedFiles });
    }
    return null;
  }
  if (verdict.decision === "standdown") {
    // evaluateCompletion already logged the stand-down loudly.
    return null;
  }
  return continuationMessage(verdict);
}

/**
 * Per-edit lint flow, shared by the `execute.after` hook (primary) and the
 * `filesystem.changed` fallback. Skipped files log at debug; passes at info;
 * failures log loudly at error (the edit already landed, so unlike
 * `execute.before` this never throws — it only reports).
 */
export async function runPerEditLint(state: HookState, filePath: string): Promise<void> {
  if (!state.config.on_edit.lint) return;
  if (state.config.precommit === "auto" && state.precommitAvailable === undefined) {
    state.precommitAvailable = await detectPreCommitAvailability(state.run, state.directory);
  }
  const outcome: LintOutcome = await state.lintLimiter.run(() =>
    lintFile(state.run, state.config, filePath, {
      cwd: state.directory,
      timeout: state.config.gate?.timeout,
      precommitAvailable: state.precommitAvailable,
    }),
  );
  if (outcome.skipped) {
    await safeLog(state, "debug", summarizeLint(outcome), {
      filePath,
      reason: outcome.reason,
    });
    return;
  }
  if (!isLintFailure(outcome)) {
    await safeLog(state, "info", summarizeLint(outcome), { filePath });
    return;
  }
  await safeLog(state, "error", summarizeLint(outcome), {
    filePath,
    command: outcome.command?.join(" "),
    stdout: outcome.result?.stdout,
    stderr: outcome.result?.stderr,
  });
}

/** Assemble the completion verdict with the state's live dependencies. */
export function runCompletion(state: HookState, sessionID: string): Promise<CompletionVerdict> {
  return evaluateCompletion({
    run: state.run,
    config: state.config,
    directory: state.directory,
    sessionID,
    tracker: state.tracker,
    blockCounts: state.blocks,
    stuckSnapshots: state.stuckSnapshots,
    lintLimiter: state.lintLimiter,
    passCache: state.passCache,
    baseline: state.initialEnforceable,
    log: (level, message, extra) => safeLog(state, level, message, extra),
  });
}

/**
 * Record a completed idle-hook evaluation for the dedup map. Stamp ONLY on
 * the completed-evaluation paths (pass, blocked-admitted, standdown);
 * throw/early-return paths must not stamp so the subscriber net retries.
 */
export function stampIdleHandled(state: HookState, sessionID: string): void {
  state.lastIdleHandled.set(sessionID, Date.now());
}

/**
 * Best-effort runtime snapshot for `/df-runtime`: hook state plus template
 * drift, fire-and-forget (never throws, never blocks the caller).
 */
export function stampRuntimeStatus(
  directory: string,
  idleHookVia: IdleHookVia,
  continuation: "idle" | "fallback" | "armed",
  skillMirrorRoot?: string,
): void {
  void (async () => {
    let templates: TemplateState | undefined;
    try {
      templates = summarizeDrift(await checkTemplateUpdates(directory, skillMirrorRoot));
    } catch {
      // Best-effort: the snapshot renders without template state.
    }
    await writeRuntimeStatus(directory, { idleHookVia, continuation, templates });
  })();
}

/**
 * True when the idle hook completed an evaluation for this session inside
 * `windowMs`. The hook itself uses a short window (same-boundary
 * double-fire guard for the dual key registration below); the subscriber
 * net uses the full window (one boundary, one gate run).
 */
export function wasIdleHandledRecently(
  state: HookState,
  sessionID: string,
  windowMs = 5_000,
): boolean {
  const at = state.lastIdleHandled.get(sessionID);
  return at !== undefined && Date.now() - at < windowMs;
}
