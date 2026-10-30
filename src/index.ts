/**
 * opencode-dev-framework V2 plugin entry point.
 *
 * V2 framework (opencode v2): Plugin.define({ id, setup(ctx) })
 * - ctx.session.hook("context"/"generate"/"compaction"/"title", ...) -> constitution injection
 * - ctx.permission.hook("evaluate", ...) -> native permission layer (Phase 25;
 *   observe-only spike in 25.1, enforcing mapper from 25.2)
 * - ctx.tool.hook("execute.before", ...) -> guardrails (backstop from Phase 25)
 * - ctx.tool.hook("execute.after", ...) -> per-edit lint + change tracking
 *   (`filesystem.changed` stays as a fallback this release; see Phase 24)
 * - ctx.event.subscribe() -> file tracking + gate enforcement via re-prompt
 * - ctx.tool.transform(...) -> custom tools
 * - ctx.command.transform(...) -> server-side `/df-goal` verified-goal
 *   wrapper (thin adapter delegating to native `/goal`; see src/goal.ts)
 *
 * Gate enforcement: no synchronous pre-stop veto. On `experimental.idle`
 * (same execution) we run the gate and if it fails inside budget we admit
 * `ctx.session.synthetic({ sessionID, text: stoppingMessage })` — the
 * continuation runs before the session goes idle (see
 * docs/plans/12-idle-hook-cutover.md). The `event.subscribe` idle net
 * stays as a deduped fallback for the boundaries the hook skips.
 */

import { Plugin } from "@opencode/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { type BlockStore, createBlockStore } from "./block-store.js";
import { clearConfigCache, loadConfig } from "./config.js";
import { type ChangedFileTracker, createChangedFileTracker } from "./gate.js";
import {
  artifactState,
  createPassCache,
  evaluateCompletion,
  PREFLIGHT_ARTIFACT_REL,
  preflightBlockReason,
  type CompletionVerdict,
  type PassCache,
} from "./harness.js";
import { runCommand, type RunCommand } from "./host.js";
import {
  createLintLimiter,
  detectPreCommitAvailability,
  isLintFailure,
  lintFile,
  summarizeLint,
  type LintLimiter,
} from "./lint.js";
import { createLogger, type LogFn, type LogLevel } from "./logger.js";
import { checkToolCall, extractFilePath, FILE_TOOLS, toPermissionGuard } from "./protect.js";
import { constitutionPresent, loadConstitution } from "./rules.js";
import { writeRuntimeStatus, type IdleHookVia } from "./runtime-status.js";
import type { ResolvedConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Internal state — single plugin instance per location.directory.
// HookState is kept in module scope, not in a registry keyed by directory,
// because V2 Context is already per-location. The map is still used for
// legacy test helpers (buildHooks) that inject a fake directory.
// ---------------------------------------------------------------------------

export interface HookState {
  directory: string;
  config: ResolvedConfig;
  log: LogFn;
  run: RunCommand;
  tracker: ChangedFileTracker;
  constitution: string | null;
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
   * `Date.now()` of the last config-mtime check. Hook fires are far more
   * frequent than config edits, so mtime stats are throttled to
   * `CONFIG_RELOAD_MIN_INTERVAL_MS`.
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
   * all stamp; throw/early-return do not). The `event.subscribe` idle net
   * skips when the stamp is fresh so one boundary never runs the gate
   * twice. Memory-only; worst case on reload is one extra suite run.
   */
  lastIdleHandled: Map<string, number>;
}

let activeState: HookState | null = null;
let fallbackLog: LogFn = async () => {};

/**
 * Minimum interval between config-mtime checks. Exported for tests.
 * Every hook fire calls `reloadConfigIfChanged`, but the config file
 * almost never changes mid-session.
 */
export const CONFIG_RELOAD_MIN_INTERVAL_MS = 1000;

function safeLog(
  state: HookState | null,
  level: LogLevel,
  message: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  const fn = state && typeof state.log === "function" ? state.log : fallbackLog;
  return fn(level, message, extra);
}

async function reloadConfigIfChanged(state: HookState): Promise<void> {
  // Throttle mtime checks: every hook fire calls this, but the config file
  // almost never changes mid-session. A 1s staleness window is invisible.
  const now = Date.now();
  if (now - state.lastConfigCheck < CONFIG_RELOAD_MIN_INTERVAL_MS) {
    return;
  }
  state.lastConfigCheck = now;
  const primary = join(state.directory, ".opencode-dev-framework.yml");
  const fallback = join(state.directory, ".dev-framework.yml");
  // check both names; stat whichever exists
  let configPath: string | null = null;
  let mtime: number | undefined;
  for (const p of [primary, fallback]) {
    try {
      const s = await stat(p);
      configPath = p;
      mtime = s.mtimeMs;
      break;
    } catch {
      // continue
    }
  }
  if (!configPath || mtime === undefined) {
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
function continuationMessage(verdict: Extract<CompletionVerdict, { decision: "blocked" }>): string {
  const why =
    verdict.reason === "review"
      ? "the peer-review requirement is unmet"
      : "the repo's checks are failing";
  return (
    `opencode-dev-framework completion gate blocked you from finishing because ${why} ` +
    `(block ${verdict.blockCount}/${verdict.maxBlocks}).\n\n${verdict.summary}\n\n` +
    `Fix the underlying cause and continue. Do NOT disable, skip, or weaken these checks to ` +
    `get past the gate. If a failure is pre-existing and unrelated to your work, prove it ` +
    `(show it fails on a clean tree) and report it to the user.`
  );
}

/** Log pass/standdown verdicts; returns the continuation message when blocked. */
async function actOnVerdict(state: HookState, verdict: CompletionVerdict): Promise<string | null> {
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
async function runPerEditLint(state: HookState, filePath: string): Promise<void> {
  if (!state.config.on_edit.lint) return;
  if (state.config.precommit === "auto" && state.precommitAvailable === undefined) {
    state.precommitAvailable = await detectPreCommitAvailability(state.run, state.directory);
  }
  const outcome = await state.lintLimiter.run(() =>
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
function runCompletion(state: HookState, sessionID: string): Promise<CompletionVerdict> {
  return evaluateCompletion({
    run: state.run,
    config: state.config,
    directory: state.directory,
    sessionID,
    tracker: state.tracker,
    blockCounts: state.blocks,
    lintLimiter: state.lintLimiter,
    passCache: state.passCache,
    log: (level, message, extra) => safeLog(state, level, message, extra),
  });
}

/**
 * Record a completed idle-hook evaluation for the dedup map. Stamp ONLY on
 * the completed-evaluation paths (pass, blocked-admitted, standdown);
 * throw/early-return paths must not stamp so the subscriber net retries.
 */
function stampIdleHandled(state: HookState, sessionID: string): void {
  state.lastIdleHandled.set(sessionID, Date.now());
}

/**
 * True when the idle hook completed an evaluation for this session inside
 * `windowMs`. The hook itself uses a short window (same-boundary
 * double-fire guard for the dual key registration below); the subscriber
 * net uses the full window (one boundary, one gate run).
 */
function wasIdleHandledRecently(state: HookState, sessionID: string, windowMs = 5_000): boolean {
  const at = state.lastIdleHandled.get(sessionID);
  return at !== undefined && Date.now() - at < windowMs;
}

// Helpers to normalize V2 event shapes (data vs properties vs direct)
function getEventSessionID(event: unknown): string | undefined {
  const e = event as Record<string, unknown>;
  // try common locations
  if (typeof e.sessionID === "string") return e.sessionID;
  const data = (e.data ?? e.properties ?? e.payload) as Record<string, unknown> | undefined;
  if (data && typeof data.sessionID === "string") return data.sessionID;
  if (data && typeof data.session_id === "string") return data.session_id as string;
  // session.status carries sessionID at data.sessionID
  if (e.properties && typeof (e.properties as Record<string, unknown>).sessionID === "string") {
    return (e.properties as Record<string, unknown>).sessionID as string;
  }
  return undefined;
}

function getEventFilePath(event: unknown): string | undefined {
  const e = event as Record<string, unknown>;
  const data = (e.data ?? e.properties ?? e.payload) as Record<string, unknown> | undefined;
  if (data && typeof data.file === "string") return data.file;
  if (data && typeof data.filePath === "string") return data.filePath as string;
  if (typeof e.file === "string") return e.file as string;
  return undefined;
}

function isIdleEvent(event: { type: string; data?: unknown; properties?: unknown }): boolean {
  if (event.type === "session.idle") return true;
  if (event.type === "session.status") {
    const d = (event as { data?: { status?: { type?: string } } }).data;
    const p = (event as { properties?: { status?: { type?: string } } }).properties;
    const statusType =
      d?.status?.type ??
      p?.status?.type ??
      (event as unknown as { status?: { type?: string } }).status?.type;
    return statusType === "idle";
  }
  if (event.type === "session.status") {
    // also handle flattened shape where data is {status: "idle"}? check
    const d2 = (event as { data?: { status?: string } }).data;
    if (d2?.status === "idle") return true;
  }
  return false;
}

function isFilesystemChangedEvent(type: string): boolean {
  return type === "filesystem.changed" || type === "file.edited" || type === "file.changed";
}

function isSessionDeletedEvent(type: string): boolean {
  return type === "session.deleted";
}

// ---------------------------------------------------------------------------
// V2 Plugin definition
// ---------------------------------------------------------------------------

const plugin = Plugin.define({
  id: "opencode-dev-framework",
  async setup(ctx: Context) {
    const log = createLogger();
    fallbackLog = log;

    const directory = ctx.location.directory as string;
    let config: ResolvedConfig;
    try {
      config = loadConfig(directory);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await log("error", message, { directory });
      // No client.app.log in V2 — stderr is enough
      return;
    }

    const { constitution, warning } = await loadConstitution(config, directory);
    if (warning) {
      await log("warn", warning);
    }

    let configMtime: number | undefined;
    for (const name of [".opencode-dev-framework.yml", ".dev-framework.yml"]) {
      try {
        configMtime = (await stat(join(directory, name))).mtimeMs;
        break;
      } catch {
        // continue
      }
    }

    const tracker = createChangedFileTracker();
    const blockCounts = new Map<string, number>();
    const blocks = createBlockStore(ctx.storage, blockCounts);

    const state: HookState = {
      directory,
      config,
      log,
      run: runCommand,
      tracker,
      constitution,
      blockCounts,
      blocks,
      configMtime,
      lintLimiter: createLintLimiter(),
      passCache: createPassCache(),
      lastConfigCheck: 0,
      lastIdleHandled: new Map<string, number>(),
    };
    activeState = state;

    // Surface a broken storage backend early (best-effort, never thrown).
    // With the stop-level hydration gone there is no setup-time storage
    // read left, so this rarely fires here — the store still degrades
    // lazily on first use and reports via isDegraded().
    if (blocks.isDegraded()) {
      await log(
        "warn",
        "ctx.storage is unavailable; gate block counts are in-memory only and reset on reload",
        { directory },
      );
    }

    // Track hook/transform registrations so teardown can unregister them.
    // `ctx.*.hook()` / `ctx.*.transform()` resolve to a `Registration`
    // ({ dispose() }) per the V2 plugin API. If teardown runs without
    // disposing, the `execute.before` closure below would stay alive while
    // `activeState` is cleared — bricking every tool call (issue #1).
    interface DisposableRegistration {
      dispose: () => Promise<void> | void;
    }
    const registrations: DisposableRegistration[] = [];
    function trackRegistration(value: unknown): void {
      if (
        value !== null &&
        typeof value === "object" &&
        "dispose" in (value as Record<string, unknown>) &&
        typeof (value as { dispose?: unknown }).dispose === "function"
      ) {
        registrations.push(value as DisposableRegistration);
      }
    }

    // Stale-hook guard: every closure below captures its own `state` and
    // no-ops when it is no longer the live singleton. This covers three
    // cases disposal alone cannot: (a) teardown with no fresh setup
    // (activeState is null), (b) teardown + reload where an old
    // registration outlives disposal (activeState is a newer state —
    // the stale hook must NOT double-enforce), and (c) teardown racing
    // an in-flight handler between awaits (captured `state` stays valid
    // while the global may be cleared). See issue #1 follow-up.
    // 1) Constitution injection — per model request (V1: experimental.chat.system.transform -> V2: session.hook("context", ...))
    trackRegistration(
      await ctx.session.hook("context", async (event) => {
        if (activeState !== state) return;
        await reloadConfigIfChanged(state);
        if (state.config.profile === "off") return;
        const constitution = state.constitution;
        if (!constitution) return;
        // V2 system is Array<SystemPart> {type:"text", text:string}
        const already = constitutionPresent(event.system, constitution);
        if (already) return;
        event.system.push({
          type: "text",
          text: constitution,
        });
        await safeLog(state, "info", "constitution injected into system prompt");
      }),
    );

    // Also hook other request kinds so the reminder is not missed on title/generate
    // (no-op if model doesn't need it; cheap)
    for (const kind of ["generate", "compaction", "title"] as const) {
      trackRegistration(
        await ctx.session.hook(kind, async (event) => {
          if (activeState !== state) return;
          const constitution = state.constitution;
          if (state.config.profile === "off" || !constitution) return;
          // generate/compaction/title also have system — inject similarly if present
          if (!event.system) return;
          const already = constitutionPresent(event.system, constitution);
          if (!already) event.system.push({ type: "text" as const, text: constitution });
        }),
      );
    }

    // 1b) Idle-first completion gate — `experimental.idle` (landed upstream
    // via anomalyco/opencode#59437; see docs/plans/12-idle-hook-cutover.md).
    // Fires where a session would otherwise go idle, inside the same
    // execution: a blocked verdict admits a synthetic continuation and the
    // runner re-checks the inbox instead of idling. Pass/stand-down admit
    // nothing. Registered defensively: on builds without core support the
    // hook is simply never dispatched, and the session.idle event net below
    // provides re-prompt enforcement instead (deduped via lastIdleHandled).
    // Both the current `experimental.idle` key and the unprefixed `idle`
    // alias are registered so a future stabilization rename is a non-event;
    // the same-boundary double-fire guard below makes that safe. Never
    // `prompt` here — only `synthetic` keeps the same execution.
    // DEFENSIVE: any-cast because the installed @opencode/plugin may predate
    // the hook; fires only on builds dispatching it.
    // idleHookVia feeds the runtime-status snapshot (`/df-runtime`): which
    // key the core accepted, so the TUI can report the hook method.
    let idleHookVia: IdleHookVia = "none";
    const handleIdleContinuation = async (event: unknown): Promise<void> => {
      if (activeState !== state) return;
      if (event === null || typeof event !== "object") return;
      // Never let a gate failure escape into core: an uncaught throw fails
      // the drain (Failed terminal), it does NOT fail open to idle. So on
      // any error — including a hostile event shape blowing up sessionID
      // resolution — abstain (admit nothing) and leave unstamped; the
      // subscriber net retries at the next idle.
      let sessionID: string | undefined;
      try {
        sessionID =
          (typeof (event as { sessionID?: unknown }).sessionID === "string" &&
            ((event as { sessionID: string }).sessionID as string)) ||
          getEventSessionID(event);
        if (!sessionID) return;
        await reloadConfigIfChanged(state);
        if (state.config.profile === "off") return;
        if (!state.config.gate) {
          await safeLog(
            state,
            "warn",
            "plugin config is incomplete (missing gate section), skipping completion gate",
            { directory: state.directory },
          );
          return;
        }
        // Same-boundary double-fire guard for the dual key registration
        // above (a future core dispatching both names for one boundary).
        // Short window on purpose: any legitimate re-fire needs a full
        // model round-trip first, which never lands inside a second.
        if (wasIdleHandledRecently(state, sessionID, 1_000)) return;
        const verdict = await runCompletion(state, sessionID);
        const message = await actOnVerdict(state, verdict);
        if (message === null || verdict.decision !== "blocked") {
          // Pass/stand-down: completed evaluation, nothing to admit.
          stampIdleHandled(state, sessionID);
          state.continuationLevel = "idle";
          void writeRuntimeStatus(state.directory, { idleHookVia, continuation: "idle" });
          return;
        }
        // Blocked: admit a synthetic continuation (same execution).
        // `background` is intentionally ignored — the gate evaluates the
        // working tree, it never waits on running work.
        if (typeof ctx.session.synthetic !== "function") {
          await safeLog(state, "warn", "gate blocked but no session.synthetic API available", {
            sessionID,
          });
          return;
        }
        await ctx.session.synthetic({ sessionID, text: message });
        stampIdleHandled(state, sessionID);
        state.continuationLevel = "idle";
        void writeRuntimeStatus(state.directory, { idleHookVia, continuation: "idle" });
        await safeLog(
          state,
          "info",
          `completion gate continued session ${sessionID} via idle hook`,
          {
            sessionID,
            blockCount: verdict.blockCount,
            maxBlocks: verdict.maxBlocks,
          },
        );
      } catch (error) {
        try {
          await safeLog(
            state,
            "warn",
            "idle continuation failed; abstaining (subscriber net retries)",
            {
              sessionID,
              error: error instanceof Error ? error.message : String(error),
            },
          );
        } catch {
          // best-effort only — the abstain itself must not throw
        }
      }
    };
    for (const name of ["experimental.idle", "idle"] as const) {
      try {
        trackRegistration(
          // biome-ignore lint/suspicious/noExplicitAny: defensive idle hook, absent from SessionHooks on older cores
          await (ctx.session as any).hook(name, handleIdleContinuation),
        );
        if (idleHookVia === "none") idleHookVia = name;
      } catch {
        await safeLog(state, "warn", `could not register session hook ${name}`, { hook: name });
      }
    }
    // Record the registration outcome for `/df-runtime` even before the
    // first dispatch: "armed" is a real state, not a missing one.
    void writeRuntimeStatus(state.directory, { idleHookVia, continuation: "armed" });
    await safeLog(
      state,
      "info",
      "registered experimental.idle hook (+ idle alias); gate failures continue the same execution via synthetic",
    );

    // 2a) Native permission layer (Phase 25): `permission.evaluate` fires
    // with `{action, resources, effect}` (shapes recorded in the 25.1 spike,
    // docs/plans/08-notes.md — never guessed: action "edit" covers
    // edit/write/patch with resources[0] = file path; action "shell" covers
    // bash/shell with resources[0] = command).
    // The mapper only ever denies or abstains (never allows), so it can
    // never weaken host/engine enforcement. `execute.before` below stays as
    // the backstop — and is the load-bearing layer: the firing investigation
    // (08-notes) proved the pipeline runs before-hooks FIRST, so evaluate
    // only ever sees calls the backstop already passed. The native layer is
    // defense-in-depth (it still matters if core ever reorders the pipeline
    // or adds paths bypassing tool hooks). Quiet paths log at debug — in
    // particular advisory warns stay debug here because execute.before
    // already warned for the same call.
    try {
      trackRegistration(
        await ctx.permission.hook("evaluate", async (event) => {
          if (activeState !== state) return;
          await reloadConfigIfChanged(state);
          if (state.config.profile === "off") return;
          const action = event.action;
          const target = event.resources[0];
          const baseExtra = {
            action,
            resources: [...event.resources],
            sessionID: event.sessionID,
          };
          // Already denied by the host/engine: abstain so its verdict and
          // message survive untouched (mirrors the backstop's hostDenies
          // stand-down; the mapper must never overwrite a denial).
          if (event.effect === "deny") {
            await safeLog(
              state,
              "debug",
              `permission.evaluate action=${action} already denied; leaving host/engine verdict untouched`,
              { ...baseExtra, message: event.message },
            );
            return;
          }
          // Pre-flight (mirrors execute.before; the artifact itself stays
          // writable). Deny/warn per profile, exactly like the backstop.
          if (state.config.preflight.length > 0 && action === "edit") {
            const artifact = await artifactState(state.directory, PREFLIGHT_ARTIFACT_REL);
            const reason = preflightBlockReason(state.config, "edit", target, artifact);
            if (reason !== null) {
              if (state.config.profile === "advisory") {
                // Debug, not warn: execute.before runs first and already
                // warned for this exact call (same double-noise rule as the
                // guardrail warn path below).
                await safeLog(state, "debug", reason, {
                  ...baseExtra,
                  artifact: PREFLIGHT_ARTIFACT_REL,
                });
                return;
              }
              event.effect = "deny";
              event.message = reason;
              await safeLog(state, "error", reason, {
                ...baseExtra,
                artifact: PREFLIGHT_ARTIFACT_REL,
              });
              return;
            }
          }
          const verdict = toPermissionGuard(state.config, action, event.resources, state.directory);
          if (verdict === null) {
            await safeLog(
              state,
              "debug",
              `permission.evaluate action=${action} effect=${event.effect} (no guardrail verdict; engine default wins)`,
              { ...baseExtra, effect: event.effect },
            );
            return;
          }
          const message = verdict.reason ?? "blocked by guardrails";
          const extra = { ...baseExtra, pattern: verdict.matchedPattern };
          if (verdict.decision === "warn") {
            // Advisory: stay silent at warn level — `execute.before` runs
            // first in the pipeline and already warned for this exact call.
            // A debug trace keeps the layer observable without double noise.
            await safeLog(state, "debug", message, extra);
            return; // leave the engine verdict untouched
          }
          event.effect = "deny";
          event.message = message;
          await safeLog(state, "error", message, extra);
        }),
      );
    } catch {
      await safeLog(
        state,
        "warn",
        "could not register permission.evaluate hook; guardrails use execute.before only",
      );
    }

    // 2) Guardrails — tool execution blocking (V1: tool.execute.before -> V2: ctx.tool.hook("execute.before", ...))
    // Stale-hook fail-open: the closure captures its own `state` and allows
    // the call whenever it is no longer live — torn down (activeState null)
    // or superseded by a newer setup (activeState is a different instance,
    // whose own hook enforces; this one must not double-enforce). Using the
    // captured `state` throughout also closes the teardown race where the
    // global is cleared between awaits. See issue #1.
    trackRegistration(
      await ctx.tool.hook("execute.before", async (event) => {
        if (activeState !== state) {
          if (activeState === null) {
            await safeLog(
              null,
              "warn",
              "[opencode-dev-framework] plugin state is not available; allowing tool call (fail-open after teardown)",
              { tool: event.tool },
            );
          }
          return;
        }
        await reloadConfigIfChanged(state);
        if (state.config.profile === "off") return;
        // V2 event shapes: { tool, sessionID, agent, messageID, id, input: unknown }
        const toolName = event.tool;
        const input = event.input;
        const sessionID = event.sessionID;

        // Pre-flight harness: when `preflight:` tasks are configured, file
        // edits are denied (standard/strict) until the pre-flight artifact
        // exists. This is a true hard gate — it runs before the edit lands.
        if (state.config.preflight.length > 0) {
          const artifact = await artifactState(state.directory, PREFLIGHT_ARTIFACT_REL);
          const reason = preflightBlockReason(
            state.config,
            toolName,
            extractFilePath(input),
            artifact,
          );
          if (reason !== null) {
            const extra = { tool: toolName, sessionID, artifact: PREFLIGHT_ARTIFACT_REL };
            if (state.config.profile === "advisory") {
              await safeLog(state, "warn", reason, extra);
            } else {
              await safeLog(state, "error", reason, extra);
              throw new Error(`[opencode-dev-framework] ${reason}`);
            }
          }
        }

        // hostPermissions: not available in V2 permission model; pass undefined (conservative — still guard)
        const result = checkToolCall(state.config, toolName, input, state.directory, undefined);
        if (result.decision === "allow") return;
        const message = result.reason ?? "blocked by guardrails";
        const extra = { tool: toolName, sessionID, pattern: result.matchedPattern };
        if (result.decision === "warn") {
          await safeLog(state, "warn", message, extra);
          return;
        }
        await safeLog(state, "error", message, extra);
        throw new Error(`[opencode-dev-framework] ${message}`);
      }),
    );

    // 2b) Per-edit lint — `tool.execute.after` (primary; the
    // `filesystem.changed` branch below stays as a fallback this release).
    // Edit tools with `completed` status are tracked + linted via the shared
    // flow; `error` status tracks without linting (the tool failed, so there
    // is nothing reliable to lint); read-only tools never touch the tracker.
    // The edit already landed, so this hook only reports — it never throws.
    trackRegistration(
      await ctx.tool.hook("execute.after", async (event) => {
        if (activeState !== state) return;
        await reloadConfigIfChanged(state);
        if (state.config.profile === "off") return;
        const filePath = extractFilePath(event.input);
        if (!filePath) return;
        if (!FILE_TOOLS.has(event.tool)) return;
        state.tracker.add(filePath, state.directory);
        if (event.status !== "completed") {
          await safeLog(
            state,
            "debug",
            `tracked ${filePath} from failed ${event.tool} call (lint skipped)`,
            { tool: event.tool, sessionID: event.sessionID, filePath },
          );
          return;
        }
        await runPerEditLint(state, filePath);
      }),
    );

    // 3) Custom tools — V2: ctx.tool.transform(editor => editor.add(...))
    trackRegistration(
      await ctx.tool.transform((editor) => {
        editor.add({
          name: "dev_framework_init",
          description:
            "Scaffold opencode-dev-framework project files (agents, skills, commands, default config) into the current project. Missing files are created; existing files are skipped unless overwrite is true.",
          input: {
            type: "object",
            properties: {
              directory: {
                type: "string",
                description: "Target project directory (defaults to current project)",
              },
              overwrite: {
                type: "boolean",
                description: "Overwrite existing files that differ from templates",
              },
            },
            additionalProperties: false,
          },
          async execute(input: unknown) {
            const { installTemplates, writeDetectedConfig } = await import("./installer.js");
            const args = input as { directory?: string; overwrite?: boolean };
            const targetDir = args.directory ?? directory;
            const result = await installTemplates(targetDir, {
              overwriteExisting: args.overwrite ?? false,
              skipExisting: !(args.overwrite ?? false),
            });
            const configResult = await writeDetectedConfig(targetDir, {
              overwriteExisting: args.overwrite ?? false,
              skipExisting: !(args.overwrite ?? false),
            });
            const lines = [
              `Installed opencode-dev-framework templates into ${targetDir}.`,
              `Created: ${result.created.length} file(s)`,
              `Overwritten: ${result.overwritten.length} file(s)`,
              `Skipped: ${result.skipped.length} file(s)`,
              `Config: ${configResult.action}`,
            ];
            if (result.created.length > 0)
              lines.push("", "Created files:", ...result.created.map((f) => `- ${f}`));
            if (result.overwritten.length > 0)
              lines.push("", "Overwritten files:", ...result.overwritten.map((f) => `- ${f}`));
            return { content: lines.join("\n") };
          },
        });

        editor.add({
          name: "dev_framework_set_profile",
          description:
            "Change the opencode-dev-framework profile (off, advisory, standard, strict) for the current project and apply it immediately without restarting OpenCode.",
          input: {
            type: "object",
            properties: {
              profile: {
                type: "string",
                description: "New profile: off, advisory, standard, or strict",
              },
              directory: {
                type: "string",
                description: "Project directory (defaults to current project)",
              },
            },
            required: ["profile"],
            additionalProperties: false,
          },
          async execute(input: unknown) {
            const { clearConfigCache: ccc, loadConfig: lc } = await import("./config.js");
            const { changeProfile } = await import("./commands.js");
            const { loadConstitution: lc2 } = await import("./rules.js");
            const args = input as { profile: string; directory?: string };
            const targetDir = args.directory ?? directory;
            const profile = args.profile.trim().toLowerCase() as ResolvedConfig["profile"];
            const valid = ["off", "advisory", "standard", "strict"] as const;
            if (!(valid as readonly string[]).includes(profile)) {
              return {
                content: `Invalid profile "${args.profile}". Valid values: ${valid.join(", ")}.`,
              };
            }
            const message = await changeProfile(targetDir, profile);
            ccc();
            const newConfig = lc(targetDir);
            const { constitution: newConstitution } = await lc2(newConfig, targetDir);
            if (state.directory === targetDir) {
              state.config = newConfig;
              state.constitution = newConstitution;
            }
            if (activeState && activeState !== state && activeState.directory === targetDir) {
              activeState.config = newConfig;
              activeState.constitution = newConstitution;
            }
            return { content: `${message} Change applied immediately.` };
          },
        });

        editor.add({
          name: "dev_framework_verify",
          description:
            "Run the full opencode-dev-framework completion contract now (typecheck, tests, changed-file lint, peer-review state) and return the summary. The first line is DEV_FRAMEWORK_VERDICT: PASS or FAIL, reporting the raw inspection outcome. Use for a mid-session gate check without waiting for session idle; unlike the idle gate this never re-prompts, it only reports, and it never mutates retry state.",
          input: {
            type: "object",
            properties: {
              directory: {
                type: "string",
                description: "Project directory (defaults to current project)",
              },
            },
            additionalProperties: false,
          },
          async execute(input: unknown) {
            const { verifyGate } = await import("./commands.js");
            const args = input as { directory?: string };
            const targetDir = args.directory ?? directory;
            const live = activeState && activeState.directory === targetDir ? activeState : null;
            const own = state.directory === targetDir ? state : null;
            const holder = live ?? own;
            // Live tracker's changed files beat the TUI's empty default: a
            // mid-session verify scopes `changed` steps to real edits.
            const cfg = holder?.config ?? loadConfig(targetDir);
            const changed = holder ? holder.tracker.getChangedFiles() : [];
            const { summary } = await verifyGate(state.run, targetDir, cfg, changed);
            return { content: summary };
          },
        });

        editor.add({
          name: "dev_framework_status",
          description:
            "Show the current opencode-dev-framework state for the project: active profile, guardrails, completion gate, on-edit behavior, tracked changed files, and block counts.",
          input: {
            type: "object",
            properties: {
              directory: {
                type: "string",
                description: "Project directory (defaults to current project)",
              },
            },
            additionalProperties: false,
          },
          async execute(input: unknown) {
            const { renderStatus } = await import("./format-status.js");
            const args = input as { directory?: string };
            const targetDir = args.directory ?? directory;
            const live = activeState && activeState.directory === targetDir ? activeState : null;
            const own = state.directory === targetDir ? state : null;
            const cfg = (live ?? own)?.config ?? loadConfig(targetDir);
            // renderStatus expects HookState? pass live ?? own (may be null for other dirs)
            return {
              content: renderStatus(
                cfg,
                (live ?? own) as unknown as Parameters<typeof renderStatus>[1],
              ),
            };
          },
        });
      }),
    );

    // 3b) Verified-goal wrapper — server-side `/df-goal` through
    // `ctx.command.transform` (see src/goal.ts for the pure policy). Thin
    // adapter around native `/goal`: probes native capability, checks
    // availability/profile/meaningful-checks, appends the verification
    // addendum verbatim, and delegates exactly once via the flat core
    // `session.command` shape. Defensive like the permission hook: on a
    // core without the command API the wrapper is skipped with a warning
    // and every other layer keeps working.
    try {
      trackRegistration(
        await ctx.command.transform((editor) => {
          editor.add({
            name: "df-goal",
            description:
              "Start a verified native goal: appends a dev_framework_verify contract to the objective and delegates to native /goal exactly once. Requires native /goal, a blocking profile, and at least one configured completion check.",
            execute: async (invocation) => {
              if (activeState !== state) return;
              await reloadConfigIfChanged(state);
              const { extractObjectiveText, isNativeGoalListed, runGoalCommand } = await import(
                "./goal.js"
              );
              let nativeGoalAvailable = false;
              try {
                nativeGoalAvailable = isNativeGoalListed(await ctx.command.list());
              } catch {
                nativeGoalAvailable = false;
              }
              // Flat core protocol shape
              // (packages/protocol/src/groups/session.ts `session.command`:
              // `{ sessionID, name: string, text, ... }`). The installed SDK
              // types still show the old nested `name: { name, text }` —
              // core source is truth (Phase 0 spike receipt).
              type FlatSessionCommand = (args: {
                sessionID: string;
                name: string;
                text: string;
              }) => Promise<unknown>;
              const sessionCommand = ctx.session.command as unknown as FlatSessionCommand;
              const result = await runGoalCommand({
                config: state.config,
                objective: extractObjectiveText(invocation.prompt),
                sessionID: invocation.sessionID,
                nativeGoalAvailable,
                delegate: (args) => sessionCommand(args),
              });
              if (!result.delegated) {
                throw new Error(result.error);
              }
            },
          });
        }),
      );
    } catch (err) {
      await safeLog(
        state,
        "warn",
        "could not register df-goal command; verified goals unavailable",
        {
          error: String(err),
        },
      );
    }

    // 4) Event subscription — file tracking + gate enforcement net.
    // Runs the gate on `session.idle` for the boundaries the §1b hook
    // skipped (interruption, failure, steer-parked drains) or for builds
    // without the hook. Skips when the hook just handled the same boundary
    // (dedup map). Synthetic-first admit: after the execution ended, a
    // synthetic message is the quietest wake; prompt is the fallback.
    const controller = new AbortController();
    const eventLoop = (async () => {
      try {
        for await (const rawEvent of ctx.event.subscribe({ signal: controller.signal })) {
          // Stale-loop guard: a previous setup's loop must exit rather than
          // hijack a newer setup's state (duplicate gate re-prompts / lint).
          if (activeState !== state) return;
          const event = rawEvent as { type: string; data?: unknown; properties?: unknown } & Record<
            string,
            unknown
          >;
          const type = event.type;

          if (isSessionDeletedEvent(type)) {
            // session.deleted: cleanup block counts (memory + storage) and
            // the idle dedup stamp for the session.
            const sid = getEventSessionID(event);
            if (sid) {
              await state.blocks.clear(sid);
              state.lastIdleHandled.delete(sid);
            }
            continue;
          }

          if (isFilesystemChangedEvent(type)) {
            if (activeState !== state) return;
            await reloadConfigIfChanged(state);
            if (state.config.profile === "off") continue;
            const filePath = getEventFilePath(event);
            if (!filePath) continue;
            // Fallback path (primary is `execute.after` since Phase 24): the
            // tracker is add-idempotent, so a file already seen via
            // `execute.after` just logs at debug instead of linting twice.
            if (state.tracker.has(filePath, state.directory)) {
              await safeLog(
                state,
                "debug",
                `already tracked ${filePath} (skipping fallback lint; execute.after is primary)`,
                { filePath },
              );
              continue;
            }
            state.tracker.add(filePath, state.directory);
            await runPerEditLint(state, filePath);
            continue;
          }

          if (isIdleEvent(event as { type: string; data?: unknown; properties?: unknown })) {
            if (activeState !== state) return;
            await reloadConfigIfChanged(state);
            if (state.config.profile === "off") continue;
            if (!state.config.gate) {
              await safeLog(
                state,
                "warn",
                "plugin config is incomplete (missing gate section), skipping completion gate",
                {
                  directory: state.directory,
                },
              );
              continue;
            }
            const sessionID = getEventSessionID(event);
            if (!sessionID) continue;
            // The §1b hook completed an evaluation for this boundary — one
            // boundary, one gate run. (Deliberately not stamped here: only
            // the hook stamps, so a hook that never fires can never be
            // starved by the net.)
            if (wasIdleHandledRecently(state, sessionID)) continue;

            const verdict = await runCompletion(state, sessionID);
            if (state.continuationLevel === undefined) {
              state.continuationLevel = "fallback";
              void writeRuntimeStatus(state.directory, { idleHookVia, continuation: "fallback" });
            }
            const message = await actOnVerdict(state, verdict);
            if (message === null) continue;
            const blockInfo =
              verdict.decision === "blocked"
                ? ` (block ${verdict.blockCount}/${verdict.maxBlocks})`
                : "";
            // blocked -> admit a continuation (net for the boundaries the
            // hook skipped: interruption, failure, steer-parked drains).
            try {
              // Prefer synthetic (quiet wake, no user turn); fallback to prompt if synthetic not available
              if (typeof ctx.session.synthetic === "function") {
                await ctx.session.synthetic({ sessionID, text: message });
              } else if (typeof ctx.session.prompt === "function") {
                await ctx.session.prompt({ sessionID, text: message });
              } else {
                await safeLog(
                  state,
                  "error",
                  `gate blocked but no session prompt API available: ${message}`,
                );
              }
              await safeLog(
                state,
                "info",
                `completion gate re-prompted session ${sessionID}${blockInfo}`,
              );
            } catch (err) {
              await safeLog(
                state,
                "error",
                `failed to re-prompt session ${sessionID} after gate block: ${String(err)}`,
                {
                  sessionID,
                },
              );
            }
          }
        }
      } catch (err) {
        if ((err as Error)?.name === "AbortError") {
          // normal on dispose
          return;
        }
        await safeLog(state, "error", `event loop error: ${String(err)}`);
      }
    })();

    // Ensure the loop doesn't block setup
    void eventLoop;

    return async () => {
      controller.abort();
      // Unregister every hook/transform registered by this setup() so a
      // teardown/reload (e.g. session_move into a worktree) does not leave
      // stale closures alive. Disposal failures are ignored — the
      // stale-hook guard (`activeState !== state` → no-op / fail-open) keeps
      // the session usable regardless.
      for (const registration of registrations) {
        try {
          await registration.dispose();
        } catch {
          // ignore — stale-hook guard is the safety net
        }
      }
      // Only clear the singleton if it is still ours; a newer setup() may
      // already have replaced it (reload race).
      if (activeState === state) {
        activeState = null;
      }
    };
  },
});

export default plugin;
