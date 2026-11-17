/**
 * DSH adapter (plan 25 slice 4, packaged promotion of the slice-3 dogfood).
 *
 * One logic, two wirings: every verdict, reason string, and gate evaluation
 * comes from core (`decideFileGuard`/`decideShellGuard`, `formatFile`/
 * `lintFile`, `runCompletion`/`actOnVerdict`). This module is only wiring:
 * Cordis event registration, `ctx.subprocess` transport, `ctx.logger`
 * logging, and `dsh-commands` slash registration.
 *
 * Seams touched: `commands` (slash registration at load) and `subprocess`
 * (lint/format/gate execution). Events (`ctx.on`) and `ctx.logger` are
 * ambient on the verified DSH build (`0.2.2-rc.3`) and need no declaration —
 * re-probe `inject` if a future host tightens seams.
 *
 * Directory: `ODF_WORKDIR` env override, else `process.cwd()`. No throw on
 * unset env (safe default); the resolved directory is the config source and
 * the `cwd` for every subprocess.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createBlockStore, createStuckSnapshotStore } from "../../core/block-store.js";

import { changeProfile, verifyGate } from "../../core/commands.js";
import { clearConfigCache, loadConfig } from "../../core/config.js";
import { renderRuntimeStatus, renderStatus } from "../../core/format-status.js";
import { createChangedFileTracker } from "../../core/gate.js";
import {
  buildVerifiedObjective,
  checkGoalAvailability,
  isNativeGoalListed,
} from "../../core/goal.js";
import {
  artifactState,
  childArtifactDenial,
  createPassCache,
  isReviewArtifact,
  PREFLIGHT_ARTIFACT_REL,
  preflightBlockReason,
} from "../../core/harness.js";
import { runInitCommand, runInitScaffold, scaffoldReportLines } from "../../core/init.js";
import {
  createLintLimiter,
  detectPreCommitAvailability,
  formatFile,
  isFormatFailure,
  isLintFailure,
  type LintOutcome,
  lintFile,
  summarizeFormat,
  summarizeLint,
} from "../../core/lint.js";
import type { LogFn } from "../../core/logger.js";
import {
  decideFileGuard,
  decideShellGuard,
  extractRedirectTargets,
  type GuardResult,
} from "../../core/protect.js";
import { renderDutyRoster } from "../../core/roster.js";
import { loadConstitution } from "../../core/rules.js";
import {
  actOnVerdict,
  getActiveState,
  getFallbackLog,
  type HookState,
  reloadConfigIfChanged,
  runCompletion,
  safeLog,
  setActiveState,
  setFallbackLog,
  stampRuntimeStatus,
} from "../../core/run-hooks.js";
import { readRuntimeStatus } from "../../core/runtime-status.js";
import type { Profile, ResolvedConfig } from "../../core/types.js";
import { checkTemplateUpdates, driftMentionLine, runUpdateCommand } from "../../core/update.js";
import { snapshotEnforceable } from "../../core/weakening.js";
import {
  type DshExec,
  type DshSessionHeader,
  extractDshCommand,
  extractDshPaths,
} from "./extract.js";

export const name = "opencode-dev-framework-dsh";

/** Seams this adapter touches: slash registration + subprocess transport. */
export const inject = ["commands", "subprocess"] as const;

/** Cap on collected subprocess output per stream (bytes). */
const COLLECT_MAX_BYTES = 1024 * 1024;

/** Grace period before a subprocess abort escalates (ms). */
const SUBPROCESS_GRACE_MS = 2000;

// ---------------------------------------------------------------------------
// Minimal structural DSH types (no DSH imports — core stays host-agnostic and
// this adapter stays dependency-free). Shapes verified against
// `deepseek-harness@39163dd` contracts (`PreToolDecision`/`PostToolDecision`,
// `Agent` live face, `dsh-commands` registration).
// ---------------------------------------------------------------------------

export interface DshCollectedStream {
  readFrom(offset: number): { text: string };
}

export interface DshSubprocessHandle {
  readonly done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  readonly collected: {
    readonly stdout?: DshCollectedStream;
    readonly stderr?: DshCollectedStream;
  };
}

export interface DshSubprocess {
  spawn(spec: {
    argv: string[];
    cwd?: string;
    stdio: {
      stdin: "ignore";
      stdout: { maxBytes: number; spill: { maxBytes: number } };
      stderr: { maxBytes: number; spill: { maxBytes: number } };
    };
    graceMs: number;
    signal?: AbortSignal;
  }): DshSubprocessHandle;
}

export interface DshLogger {
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
  debug(message: string, extra?: Record<string, unknown>): void;
}

export interface DshUserMessage {
  role: "user";
  content: Array<{ type: "text"; text: string }>;
  source: { kind: string };
}

export interface DshAgent {
  readonly id?: unknown;
  readonly session?: {
    readonly header?: DshSessionHeader & {
      readonly id?: unknown;
    };
  };
  steer?(message: DshUserMessage): void;
  followup?(message: DshUserMessage): void;
}

/** Structured error identity for denials, mirroring the host `ToolErrorInfo`. */
export interface DshToolErrorInfo {
  name: string;
  code: string;
  reason?: string;
}

/** Stable identity stamped on every ODF denial so host diagnostics can attribute it. */
function odfInfo(
  code: "guard-deny" | "guard-error" | "preflight-deny" | "lint-block" | "child-artifact-deny",
): DshToolErrorInfo {
  return { name: "opencode-dev-framework", code };
}

export type DshPreDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string; info?: DshToolErrorInfo }
  | { kind: "cancel" }
  | { kind: "ask"; reason?: string };

export type DshPostDecision =
  | { kind: "accept"; additionalContexts?: DshUserMessage[] }
  | {
      kind: "block";
      feedback: Array<{ type: "text"; text: string }>;
      info?: DshToolErrorInfo;
      additionalContexts?: DshUserMessage[];
    };

/** `agent/pre-step` decision: reject the step or let edited messages enter. */
export type DshPreStepDecision = { kind: "reject" } | { kind: "enter"; messages: DshUserMessage[] };

/** What a DSH command handler receives: the invoking agent, raw input, abort. */
export interface DshCommandInvocation {
  readonly agent: DshAgent;
  readonly rawInput: string;
  readonly signal?: AbortSignal;
}

/** What a DSH command handler returns: text rendered by the dispatching UI. */
export type DshCommandResult = { kind: "success"; text?: string } | { kind: "error"; text: string };

/** Host goal service (`ctx.goals`), used only by `df-goal`. */
export interface DshGoals {
  create(agent: DshAgent, request: { objective: string }): unknown;
}

export interface DshCommands {
  register(def: {
    name: string;
    description: string;
    input?: { hint?: string };
    handler: (invocation: DshCommandInvocation) => DshCommandResult | Promise<DshCommandResult>;
  }): void;
  /** Optional: present on hosts that expose the command list (used to probe for native `/goal`). */
  list?: (
    agent: DshAgent,
  ) => ReadonlyArray<{ name: string }> | Promise<ReadonlyArray<{ name: string }>>;
}

export interface DshToolResult {
  readonly isError: boolean;
}

/** Host tool service (`ctx.tools`), used only for agent-invokable tools. */
export interface DshTools {
  register(definition: DshToolDefinition): void;
}

/**
 * Minimal tool definition twin: the plain-object shape the host's
 * `ctx.tools.register` consumes. Deliberately NOT imported from the
 * host's `@deepseek-ai/dsh-tools` package — that package is workspace
 * internal (not published), and this plugin keeps zero runtime
 * dependencies. The shape mirrors `defineTool` output: JSON-Schema
 * parameters, a canonical string value schema with a text renderer,
 * and an async execute returning the canonical value.
 */
export interface DshToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly output: {
    readonly schema: Record<string, unknown>;
    render: (args: unknown, value: unknown) => Array<{ type: "text"; text: string }>;
  };
  readonly isConcurrencySafe?: (args: unknown) => boolean;
  execute: (args: unknown, exec: unknown) => Promise<unknown>;
}

/** Structural plugin context: only the seams the adapter touches. */
export interface DshContext {
  readonly subprocess: DshSubprocess;
  readonly logger: DshLogger;
  readonly commands: DshCommands;
  readonly tools?: DshTools;
  readonly goals?: DshGoals;
  on(
    event: "tools/pre-execute",
    listener: (exec: DshExec, next: () => Promise<DshPreDecision>) => Promise<DshPreDecision>,
  ): void;
  on(
    event: "tools/post-execute",
    listener: (
      exec: DshExec,
      result: DshToolResult,
      next: () => Promise<DshPostDecision>,
    ) => Promise<DshPostDecision>,
  ): void;
  on(
    event: "agent/turn-stopping",
    // `signal` is honored: a gate block computed against an aborted turn
    // drops its steer instead of waking a new turn with stale feedback.
    listener: (payload: {
      agent: DshAgent;
      turn: unknown;
      signal?: AbortSignal;
    }) => Promise<void> | void,
  ): void;
  on(
    event: "agent/pre-step",
    // Constitution injection point: replace the entering messages once
    // per session so the agent works under the framework contract from
    // its first step (mirror of the OpenCode context-hook injection).
    listener: (
      payload: {
        agent: DshAgent;
        messages: DshUserMessage[];
        turn: unknown;
        step?: unknown;
        signal?: AbortSignal;
      },
      next: () => Promise<DshPreStepDecision>,
    ) => Promise<DshPreStepDecision>,
  ): void;
}

/** Resolve the project directory: explicit env override, else process cwd. */
export function resolveDshDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["ODF_WORKDIR"];
  if (typeof override === "string" && override !== "") {
    return override;
  }
  return process.cwd();
}

/** `RunCommand` over `ctx.subprocess`: the `(string[], {cwd, timeout})` shape core expects. */
function runOverSubprocess(ctx: DshContext, directory: string) {
  return async (command: string[], options: { cwd?: string; timeout?: number } = {}) => {
    const controller = new AbortController();
    const timeoutMs = (options.timeout ?? 60) * 1000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const collect = (maxBytes: number) => ({ maxBytes, spill: { maxBytes } });
    try {
      const handle = ctx.subprocess.spawn({
        argv: command,
        cwd: options.cwd ?? directory,
        stdio: {
          stdin: "ignore",
          stdout: collect(COLLECT_MAX_BYTES),
          stderr: collect(COLLECT_MAX_BYTES),
        },
        graceMs: SUBPROCESS_GRACE_MS,
        signal: controller.signal,
      });
      const outcome = await handle.done;
      const stdout = handle.collected.stdout?.readFrom(0).text ?? "";
      const stderr = handle.collected.stderr?.readFrom(0).text ?? "";
      return { stdout, stderr, exitCode: outcome.exitCode ?? 1, timedOut };
    } catch (error) {
      return {
        stdout: "",
        stderr: String((error as Error)?.message ?? error),
        exitCode: 127,
        timedOut,
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Register one agent-invokable tool, isolated: a host that rejects one
 * definition (shape drift, name clash) still gets the rest, and a host
 * without a tool service keeps every command. The definition is built in
 * the host's compiled `defineTool` shape (see `DshToolDefinition`) so no
 * host-internal import is needed.
 */
function registerDshTool(
  ctx: DshContext,
  state: HookState,
  def: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    isConcurrencySafe?: (args: unknown) => boolean;
    execute: (input: unknown) => Promise<string>;
  },
): void {
  const register = ctx.tools?.register;
  if (typeof register !== "function") {
    void safeLog(state, "warn", `tool service unavailable; skipping agent tool ${def.name}`);
    return;
  }
  try {
    register({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      output: {
        schema: { type: "string" },
        render: (_args, value) => [
          { type: "text", text: typeof value === "string" ? value : String(value) },
        ],
      },
      ...(def.isConcurrencySafe === undefined ? {} : { isConcurrencySafe: def.isConcurrencySafe }),
      execute: (args: unknown, _exec: unknown) => def.execute(args),
    });
  } catch (error) {
    void safeLog(state, "warn", `agent tool ${def.name} rejected by host; commands still work`, {
      error: String((error as Error)?.message ?? error),
    });
  }
}

function toPreDecision(result: GuardResult): DshPreDecision {
  // `warn` never blocks on any host: it allows with a warn log, exactly like
  // the OpenCode adapter. (`ask` is deliberately never emitted: without an
  // approval service the host denies it, which would convert advisory
  // warnings into blocks — the opposite of the warn contract. The `ask`
  // variant stays in `DshPreDecision` because the host contract owns it.)
  if (result.decision !== "deny") {
    return { kind: "allow" };
  }
  // Fallback literal is unreachable armor: core `enforce()` always sets
  // `reason` on deny, so the deny path carries one.
  return {
    kind: "deny",
    reason: result.reason ?? "blocked by guardrails",
    info: odfInfo("guard-deny"),
  };
}

/**
 * What a guard *evaluation failure* (not a verdict — an exception) does.
 * Profile-dependent like every other enforcement decision: advisory and
 * off report and allow; standard/strict fail closed (unknown =
 * untrusted). Pure for testability. (`off` never reaches evaluation —
 * the kill switch returns first — but mapping it to allow keeps the
 * helper safe under any future call ordering.)
 */
export function guardErrorDecision(profile: Profile): "allow" | "deny" {
  return profile === "advisory" || profile === "off" ? "allow" : "deny";
}

/** Cap for the linter-output body in one feedback line (the `lint failed for…` header adds a little more). */
const MAX_LINT_FEEDBACK_CHARS = 4000;

/** Maximum fault lines in one block decision; the tail names the rest. */
const MAX_LINT_BLOCK_LINES = 5;

/** Suffix marking truncated feedback; the char cap is exact by construction. */
const TRUNCATED_SUFFIX = "… (truncated)";

/**
 * Model-fault lint failures for a post-execute `block` decision.
 * A finding blames the edit, so the model sees it as a failed tool call
 * and fixes it in the same turn — stronger than the OpenCode
 * `execute.after`, which can only log after the edit lands. A finding
 * means: nonzero exit, no timeout, not the 127 command-not-found
 * convention, and the linter actually printed something. Everything else
 * (timeouts, spawn failures, missing binaries, silent crashes and silent
 * nonzero exits) is infra the model cannot fix by editing: accept +
 * error-log, file still tracked, gate re-checks. Pure for testability.
 */
export function lintBlockLines(outcomes: LintOutcome[]): string[] {
  const faults: Array<{ filePath: string; line: string }> = [];
  for (const outcome of outcomes) {
    if (outcome.skipped || outcome.result === undefined) {
      continue;
    }
    if (outcome.result.timedOut || outcome.result.exitCode === 0) {
      continue;
    }
    // Exit 127 is the command-not-found convention (shells and the
    // adapter's own spawn transport both use it): the linter never ran.
    if (outcome.result.exitCode === 127) {
      continue;
    }
    const output = [outcome.result.stdout, outcome.result.stderr]
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .join("\n");
    // A nonzero exit with no output anywhere is infra noise, not evidence:
    // a linter with real findings prints them. The gate re-runs the same
    // command and surfaces whatever it says.
    if (output === "") {
      continue;
    }
    const capped =
      output.length > MAX_LINT_FEEDBACK_CHARS
        ? `${output.slice(0, MAX_LINT_FEEDBACK_CHARS - TRUNCATED_SUFFIX.length)}${TRUNCATED_SUFFIX}`
        : output;
    faults.push({
      filePath: outcome.filePath,
      line: `lint failed for ${outcome.filePath} (exit ${outcome.result.exitCode}):\n${capped}`,
    });
  }
  if (faults.length <= MAX_LINT_BLOCK_LINES) {
    return faults.map((fault) => fault.line);
  }
  // Name the omitted files instead of asserting gate coverage: under the
  // default `standard` profile the gate does not re-lint, so the tail is
  // the only place the model learns which files still need attention.
  const shown = faults.slice(0, MAX_LINT_BLOCK_LINES);
  const omitted = faults.slice(MAX_LINT_BLOCK_LINES).map((fault) => fault.filePath);
  return [
    ...shown.map((fault) => fault.line),
    `(findings omitted for ${omitted.length} more files: ${omitted.join(", ")})`,
  ];
}

function dshUserMessage(text: string): DshUserMessage {
  return { role: "user", content: [{ type: "text", text }], source: { kind: "user" } };
}

/** Warn when an apply_patch envelope carries no recognizable file headers. */
function warnApplyPatchSkip(
  state: HookState,
  exec: DshExec,
  rawInput: unknown,
  paths: string[],
): void {
  if (
    exec.name === "apply_patch" &&
    typeof rawInput === "string" &&
    rawInput !== "" &&
    paths.length === 0
  ) {
    void safeLog(state, "warn", "apply_patch with no recognized file headers — hooks skipping", {
      tool: exec.name,
    });
  }
}

/** Best-effort session identity for gate block accounting. */
function sessionOf(agent: DshAgent, turn: unknown): string {
  const headerId = agent.session?.header?.id;
  if (typeof headerId === "string" && headerId !== "") {
    return headerId;
  }
  if (typeof agent.id === "string" && agent.id !== "") {
    return agent.id;
  }
  return `turn-${typeof turn === "number" ? turn : "unknown"}`;
}

/** True when the session is fully off (no gates of any kind). */
function isProfileOff(state: HookState): boolean {
  return state.config.profile === "off";
}

/**
 * Child-session predicate for the review-duty guard. DSH-native shape:
 * the host attaches the session header to the agent, so parentage is a
 * synchronous header read — no session lookup, no cache, no walk (all of
 * that is OpenCode's problem, where the event carries no parentage).
 * The rule mirrors the host's own classification: `parentSession` names
 * the direct creator, but historical ordinary forks may retain it, so a
 * child is `origin === "subagent"` *with* a creator id (cf. the host's
 * `archive-admission` walk condition). An absent agent or header reads
 * as top-level — the pre-existing behavior, never a new block.
 */
export function isChildAgent(agent: DshAgent | DshExec["agent"] | undefined): boolean {
  const header = agent?.session?.header;
  if (header?.origin !== "subagent") {
    return false;
  }
  return typeof header.parentSession === "string" && header.parentSession !== "";
}

/**
 * Register the ODF gates on a DSH Cordis context. Synchronous like every
 * DSH plugin `apply`. A project without (or with a broken) config gets no
 * hooks at all — error-logged, never throwing: failing the whole host
 * mount for one project's missing yml would brick unrelated sessions
 * (mirror of the OpenCode adapter's setup behavior).
 */
export function apply(ctx: DshContext): void {
  const directory = resolveDshDirectory();
  let log: LogFn = getFallbackLog();
  try {
    const hostLogger = ctx.logger;
    log = async (level, message, extra) => {
      hostLogger[level](`[odf] ${message}`, extra);
    };
  } catch {
    // Keep the fallback logger when the host logger is unavailable.
  }
  setFallbackLog(log);

  let config: ResolvedConfig;
  try {
    config = loadConfig(directory);
  } catch (error) {
    void log(
      "error",
      `loadConfig(${directory}) failed: ${(error as Error)?.message ?? error} — ODF gates disabled`,
    );
    return;
  }
  const run = runOverSubprocess(ctx, directory);
  const blockCounts = new Map<string, number>();
  const state: HookState = {
    directory,
    config,
    initialEnforceable: snapshotEnforceable(config),
    log,
    run,
    tracker: createChangedFileTracker(),
    constitution: null,
    blockCounts,
    blocks: createBlockStore(undefined, blockCounts),
    stuckSnapshots: createStuckSnapshotStore(undefined),
    lintLimiter: createLintLimiter(),
    passCache: createPassCache(),
    lastConfigCheck: 0,
    lastIdleHandled: new Map<string, number>(),
  };
  setActiveState(state);
  // Runtime snapshot for `df-runtime` (fire-and-forget, never throws):
  // "armed" until a gate evaluation reports otherwise.
  stampRuntimeStatus(state.directory, "turn-stopping", "armed");

  // Re-entrancy guard: `formatFile` mutates, so it re-fires `post-execute`.
  // The guard lives here, never in core (plan 25 §Risks).
  const inflight = new Set<string>();

  // Sessions that already received the constitution prepend, mapped to the
  // config mtime it was built from: a mid-session config change refreshes
  // the injection on the next step (mirror of the OpenCode per-request
  // injection; history already admitted keeps the old text on both hosts).
  // The marker is a number, never a config reference, so old configs are
  // not pinned in memory for the host's lifetime. Keys come from
  // `sessionOf`: stable host ids in production, turn-number fallback in
  // id-less contexts (test stubs).
  const injectedSessions = new Map<string, number | undefined>();

  ctx.on("tools/pre-execute", async (exec, next) => {
    try {
      await reloadConfigIfChanged(state);
      // Fully off means no gates of any kind. `protect_off` only stands
      // down the *guardrails* — pre-flight below still fires under it,
      // mirroring the OpenCode `execute.before` (bail on profile-off only).
      if (isProfileOff(state)) {
        return next();
      }
      const paths = extractDshPaths(exec);
      const rawInput =
        typeof exec.arguments === "object" && exec.arguments !== null
          ? (exec.arguments as Record<string, unknown>)["input"]
          : undefined;
      warnApplyPatchSkip(state, exec, rawInput, paths);
      // Children never write the parent's review artifact. Not a
      // guardrail — it fires under `protect_off` too — so it sits above
      // both pre-flight and the guard tiers, where the specific duty
      // message wins. File tools by target path, shell tools by redirect
      // target; a bare mention (grep, cat without redirect) stays
      // allowed. Top-level sessions pass through: the duty is theirs.
      {
        const command = extractDshCommand(exec);
        const candidates =
          command === undefined ? paths : [...paths, ...extractRedirectTargets(command)];
        if (candidates.some((p) => isReviewArtifact(p, state.directory))) {
          if (isChildAgent(exec.agent)) {
            const reason = childArtifactDenial();
            if (state.config.profile === "advisory") {
              await safeLog(state, "warn", reason, { tool: exec.name });
            } else {
              await safeLog(state, "error", reason, { tool: exec.name });
              return {
                kind: "deny",
                reason,
                info: odfInfo("child-artifact-deny"),
              } satisfies DshPreDecision;
            }
          }
        }
      }
      // Pre-flight harness (mirror of the OpenCode `execute.before` order:
      // pre-flight before guardrails, advisory warns and continues). Only
      // file-tool paths are gated — shell tools fall through to the guard
      // tiers below, exactly like `preflightBlockReason` returning null for
      // non-file tools on the OpenCode side. DSH names its patch tool
      // `apply_patch`; core knows it as `patch` — map the envelope
      // vocabulary before calling in, the same normalization `extractDshPaths`
      // already performs for paths.
      if (state.config.preflight.length > 0) {
        const preflightTool = exec.name === "apply_patch" ? "patch" : exec.name;
        const artifact = await artifactState(state.directory, PREFLIGHT_ARTIFACT_REL);
        for (const filePath of paths) {
          const reason = preflightBlockReason(
            state.config,
            preflightTool,
            filePath,
            artifact,
            state.directory,
          );
          if (reason !== null) {
            if (state.config.profile === "advisory") {
              await safeLog(state, "warn", reason, { tool: exec.name, filePath });
            } else {
              await safeLog(state, "error", reason, { tool: exec.name, filePath });
              return {
                kind: "deny",
                reason,
                info: odfInfo("preflight-deny"),
              } satisfies DshPreDecision;
            }
          }
        }
      }
      // `protect_off` stands down the guardrails only — pre-flight above
      // already fired. (Profile-off bailed at the top: no gates at all.)
      if (state.config.protect_off === true) {
        return next();
      }
      const command = extractDshCommand(exec);
      if (command !== undefined) {
        const verdict = decideShellGuard(state.config, command, undefined, exec.name);
        if (verdict.decision !== "allow") {
          await safeLog(state, "warn", verdict.reason ?? "shell call blocked", { tool: exec.name });
          return toPreDecision(verdict);
        }
        for (const target of extractRedirectTargets(command)) {
          const fileVerdict = decideFileGuard(
            state.config,
            target,
            state.directory,
            undefined,
            exec.name,
          );
          if (fileVerdict.decision !== "allow") {
            await safeLog(state, "warn", fileVerdict.reason ?? "redirect target blocked", {
              tool: exec.name,
              target,
            });
            return toPreDecision(fileVerdict);
          }
        }
      }
      for (const filePath of paths) {
        const verdict = decideFileGuard(
          state.config,
          filePath,
          state.directory,
          undefined,
          exec.name,
        );
        if (verdict.decision !== "allow") {
          await safeLog(state, "warn", verdict.reason ?? "file call blocked", {
            tool: exec.name,
            filePath,
          });
          return toPreDecision(verdict);
        }
      }
    } catch (error) {
      // Evaluation failure (not a verdict): profile-dependent, like every
      // other enforcement decision. Advisory reports and allows;
      // standard/strict fail closed — a guard that cannot evaluate must not
      // silently permit. (Post-execute stays fail-open under every profile:
      // the edit already landed, so there is nothing left to gate.)
      const message = `pre-execute guard error: ${(error as Error)?.message ?? error}`;
      if (guardErrorDecision(state.config.profile) === "deny") {
        await safeLog(state, "error", message);
        return {
          kind: "deny",
          reason: message,
          info: odfInfo("guard-error"),
        } satisfies DshPreDecision;
      }
      await safeLog(state, "warn", message);
    }
    return next();
  });

  ctx.on("tools/post-execute", async (exec, result, next) => {
    try {
      await reloadConfigIfChanged(state);
      // Only a fully-off profile skips tracking and lint: `protect_off`
      // stands down guardrails, not the per-edit evidence the gate reads —
      // mirroring the OpenCode `execute.after`.
      if (isProfileOff(state)) {
        return next();
      }
      const command = extractDshCommand(exec);
      const redirectTargets = command !== undefined ? extractRedirectTargets(command) : [];
      const paths = [...new Set([...extractDshPaths(exec), ...redirectTargets])];
      if (paths.length === 0) {
        return next();
      }
      // Track first, like the OpenCode `execute.after`: a failed tool call
      // may still have partially applied its write, and the gate must see it.
      // Only format/lint are skipped on error.
      for (const filePath of paths) {
        state.tracker.add(filePath, state.directory);
      }
      if (result.isError) {
        return next();
      }
      const execArgs = exec.arguments;
      const rawInput =
        typeof execArgs === "object" && execArgs !== null
          ? (execArgs as Record<string, unknown>)["input"]
          : undefined;
      warnApplyPatchSkip(state, exec, rawInput, paths);
      if (state.config.precommit === "auto" && state.precommitAvailable === undefined) {
        state.precommitAvailable = await detectPreCommitAvailability(run, state.directory);
      }
      const timeout = state.config.gate?.timeout;
      const reports: string[] = [];
      const lintOutcomes: LintOutcome[] = [];
      for (const filePath of paths) {
        if (inflight.has(filePath)) {
          continue;
        }
        inflight.add(filePath);
        try {
          await state.lintLimiter.run(async () => {
            // Format-then-lint: a formatter that rewrites must run before the
            // linter reads, so the linter never flags what the formatter fixes.
            // Skips stay at debug (core `runPerEditLint` contract) — only real
            // outcomes reach `reports` and the agent context.
            if (state.config.on_edit.format === true) {
              const formatted = await formatFile(run, state.config, filePath, {
                cwd: state.directory,
                timeout,
              });
              if (formatted.skipped) {
                await safeLog(state, "debug", summarizeFormat(formatted), { filePath });
              } else {
                reports.push(summarizeFormat(formatted));
              }
              if (isFormatFailure(formatted)) {
                await safeLog(state, "error", summarizeFormat(formatted), {
                  filePath,
                  command: formatted.command?.join(" "),
                  stdout: formatted.result?.stdout,
                  stderr: formatted.result?.stderr,
                });
              }
            }
            if (state.config.on_edit.lint === true) {
              const linted = await lintFile(run, state.config, filePath, {
                cwd: state.directory,
                timeout,
                precommitAvailable: state.precommitAvailable,
              });
              if (linted.skipped) {
                await safeLog(state, "debug", summarizeLint(linted), { filePath });
              } else {
                reports.push(summarizeLint(linted));
                lintOutcomes.push(linted);
              }
              if (!linted.skipped) {
                await safeLog(
                  state,
                  isLintFailure(linted) ? "error" : "info",
                  summarizeLint(linted),
                  { filePath },
                );
              }
            }
          });
        } finally {
          inflight.delete(filePath);
        }
      }
      // Model-fault lint findings fail the tool call itself (`block` turns
      // the result into a model-facing error): the agent fixes its edit in
      // the same turn instead of sailing on to be caught at the gate. The
      // OpenCode `execute.after` cannot do this — a landed edit can only be
      // logged. Advisory never blocks; format outcomes never block (the
      // formatter is fix-up, and its nonzero exits are ambiguous infra);
      // infra-looking lint outcomes (timeouts, 127, silent exits) stay
      // accept + error-log with the file tracked for the gate.
      const faults = lintBlockLines(lintOutcomes);
      if (faults.length > 0 && state.config.profile !== "advisory") {
        await safeLog(state, "error", `post-execute lint blocks ${paths.join(", ")}`, {
          faults: faults.length,
        });
        return {
          kind: "block",
          feedback: [
            {
              type: "text",
              text: `[odf post-execute] your edit introduced lint findings; fix them and retry:\n${faults.join("\n")}`,
            },
          ],
          info: odfInfo("lint-block"),
        };
      }
      if (reports.length > 0) {
        return {
          kind: "accept",
          additionalContexts: [dshUserMessage(`[odf post-execute]\n${reports.join("\n")}`)],
        };
      }
    } catch (error) {
      await safeLog(
        state,
        "warn",
        `post-execute error (fail-open): ${(error as Error)?.message ?? error}`,
      );
    }
    return next();
  });

  ctx.on("agent/pre-step", async ({ agent, messages, turn }, next) => {
    try {
      await reloadConfigIfChanged(state);
      // Fully off means no instruction either — mirroring the OpenCode
      // context hook, which returns before touching the system prompt.
      if (isProfileOff(state)) {
        return next();
      }
      // Nothing proposed, nothing to prepend to (mirror of the Codex
      // pre-step guard in the host tree).
      if (messages.length === 0) {
        return next();
      }
      const key = sessionOf(agent, turn);
      // Already injected under the current config: pass through (the
      // once-per-session rule; admitted history keeps its copy, exactly
      // like system text already admitted on the OpenCode side).
      if (injectedSessions.get(key) === state.configMtime) {
        return next();
      }
      if (state.constitution === null) {
        const loaded = await loadConstitution(state.config, state.directory);
        state.constitution = loaded.constitution;
        if (loaded.warning !== undefined) {
          await safeLog(state, "warn", loaded.warning);
        }
      }
      const prepend: DshUserMessage[] = [];
      if (state.constitution !== null) {
        prepend.push(dshUserMessage(state.constitution));
      }
      const roster = renderDutyRoster(state.config);
      if (roster !== null) {
        prepend.push(dshUserMessage(roster));
        await safeLog(state, "debug", "duty roster prepended at session start");
      }
      // Startup template-drift mention — once per session, best-effort.
      // First pre-step of a session is session startup (mount has no
      // session to mention into). Never throws into step assembly.
      try {
        const line = driftMentionLine(await checkTemplateUpdates(state.directory));
        if (line !== null) {
          prepend.push(dshUserMessage(line));
          await safeLog(state, "debug", "template drift mentioned at session startup");
        }
      } catch (error) {
        await safeLog(state, "debug", "startup drift check failed silently", {
          error: String(error),
        });
      }
      if (prepend.length === 0) {
        return next();
      }
      injectedSessions.set(key, state.configMtime);
      await safeLog(state, "info", "constitution injected at session start");
      return { kind: "enter", messages: [...prepend, ...messages] };
    } catch (error) {
      // Injection is advisory by nature (the gates still enforce): never
      // let a load failure break step assembly.
      await safeLog(
        state,
        "warn",
        `pre-step inject error (fail-open): ${(error as Error)?.message ?? error}`,
      );
      return next();
    }
  });

  ctx.on("agent/turn-stopping", async ({ agent, turn, signal }) => {
    try {
      // Children owe no review duty: the artifact belongs to the
      // top-level session, so a child idling on a dirty tree must never
      // be steered into the review loop. Skip before any gate work — no
      // verdict, no steer, no stamp. The parent answers for the shared
      // tree at its own boundary.
      if (isChildAgent(agent)) {
        await safeLog(state, "debug", "completion gate skipped: child session owes no review duty");
        return;
      }
      await reloadConfigIfChanged(state);
      // Only a fully-off profile skips the gate: `protect_off` stands
      // down guardrails, not the completion contract — mirroring the
      // OpenCode idle gate, which never consults `protect_off`.
      if (isProfileOff(state)) {
        return;
      }
      const sessionID = sessionOf(agent, turn);
      const verdict = await runCompletion(state, sessionID);
      const message = await actOnVerdict(state, verdict);
      // Refresh the `df-runtime` snapshot: a block steers the same turn
      // ("idle" = gate failures continue the same execution); pass and
      // standdown leave the gate armed for the next turn.
      stampRuntimeStatus(state.directory, "turn-stopping", message === null ? "armed" : "idle");
      if (message === null) {
        return;
      }
      // Blocked: steer the turn back with the gate summary. This is the
      // superiority over the OpenCode idle gate: `turn-stopping` fires
      // pre-terminal (the host awaits listeners, then re-reads its inbox —
      // fresh steering runs another step of the SAME turn), so the turn
      // never closes and no re-prompt round-trip is needed. `followup`
      // queues a turn only when steering is unavailable. Budget exhaustion
      // is already a core `standdown` verdict (no steer) — the adapter
      // never counts blocks itself.
      const followup = dshUserMessage(message);
      try {
        // Single abort check immediately before steering: an abort landing
        // between gate evaluation and this line must not wake a new turn
        // with stale feedback (host `send` reroutes waking input after
        // abort). Nothing that touches the inbox runs between check and
        // steer, so the window is closed. The log keeps the evidence.
        if (signal?.aborted === true) {
          await safeLog(
            state,
            "debug",
            "turn-stopping gate blocked but turn aborted; steer dropped",
            {
              sessionID,
            },
          );
        } else if (typeof agent.steer === "function") {
          agent.steer(followup);
        } else if (typeof agent.followup === "function") {
          agent.followup(followup);
        } else {
          await safeLog(
            state,
            "warn",
            "turn-stopping blocked but agent has no steer/followup seam",
          );
        }
      } catch (error) {
        await safeLog(
          state,
          "warn",
          `turn-stopping steer failed (seam gap): ${(error as Error)?.message ?? error}`,
        );
      }
    } catch (error) {
      await safeLog(state, "warn", `turn-stopping error: ${(error as Error)?.message ?? error}`);
    }
  });

  ctx.commands.register({
    name: "df-status",
    description: "Show opencode-dev-framework gate status (profile, config, enforcement level).",
    handler: () => ({ kind: "success", text: renderStatus(state.config, state) }),
  });

  // Runtime snapshot: hook registration, gate continuation posture, and
  // template drift — the console-text shape of the TUI `/df-runtime`
  // modal (a DSH host has no dialog surface; the text IS the surface).
  // The snapshot is stamped by `apply()` ("armed") and refreshed by every
  // turn-stopping evaluation; absent until the first stamp lands.
  ctx.commands.register({
    name: "df-runtime",
    description:
      "Show plugin version and live hook/gate runtime state (hook registration, continuation posture, template drift).",
    handler: async () => {
      try {
        await reloadConfigIfChanged(state);
        const snapshot = await readRuntimeStatus(state.directory);
        return { kind: "success", text: renderRuntimeStatus(snapshot) };
      } catch (error) {
        return { kind: "error", text: `df-runtime failed: ${(error as Error)?.message ?? error}` };
      }
    },
  });

  // Verified goal: availability check + pure verified-objective build, then
  // delegate to the host goal service (`ctx.goals.create`, the DSH-native
  // equivalent of opencode's `session.command` delegation). Same contract
  // as opencode's `/df-goal`: blocking profile required, native goal
  // required, objective wrapped exactly once, no unverified fallback.
  ctx.commands.register({
    name: "df-goal",
    description:
      "Start a verified native goal: appends a dev_framework_verify contract to the objective and creates the host goal exactly once. Requires native /goal and a blocking profile.",
    input: { hint: "<objective>" },
    handler: async (invocation) => {
      try {
        invocation.signal?.throwIfAborted();
        await reloadConfigIfChanged(state);
        const objective = invocation.rawInput.trim();
        let nativeGoalAvailable = false;
        try {
          // Core tolerates bare-array and `{data: [...]}`-wrapped
          // listings alike; anything unrecognized fails closed.
          nativeGoalAvailable =
            typeof ctx.commands.list === "function"
              ? isNativeGoalListed(await ctx.commands.list(invocation.agent))
              : false;
        } catch {
          nativeGoalAvailable = false;
        }
        const availability = checkGoalAvailability(state.config, nativeGoalAvailable);
        if (!availability.ok) {
          return { kind: "error", text: availability.error };
        }
        const built = buildVerifiedObjective(objective);
        if (!built.ok) {
          return { kind: "error", text: built.error };
        }
        if (typeof ctx.goals?.create !== "function") {
          return {
            kind: "error",
            text: "Cannot start a verified goal: the host goal service is not available on this core. Run the objective without verification where a goal service exists.",
          };
        }
        await ctx.goals.create(invocation.agent, { objective: built.text });
        return {
          kind: "success",
          text:
            `Verified goal created via native /goal${built.alreadyWrapped ? " (objective already wrapped, reused verbatim)" : ""}.\n` +
            `Objective (with verification contract):\n${built.text}`,
        };
      } catch (error) {
        return { kind: "error", text: `df-goal failed: ${(error as Error)?.message ?? error}` };
      }
    },
  });

  // On-demand gate: same full completion contract as the turn-stopping gate,
  // run when asked instead of at the boundary. Fills the slot the missing
  // TUI `/df-verify` leaves on DSH.
  ctx.commands.register({
    name: "df-verify",
    description:
      "Run the full completion gate on demand (typecheck, tests, lint, review state) and report PASS/FAIL. Side-effect-free: never retries, never steers.",
    handler: async () => {
      try {
        await reloadConfigIfChanged(state);
        const result = await verifyGate(
          run,
          state.directory,
          state.config,
          state.tracker.getChangedFiles(),
        );
        return { kind: "success", text: result.summary };
      } catch (error) {
        return { kind: "error", text: `df-verify failed: ${(error as Error)?.message ?? error}` };
      }
    },
  });

  // Profile switch: same `changeProfile` core as the TUI modal and the
  // `dev_framework_set_profile` custom tool on OpenCode. The adapter
  // picks the new profile up on the next tool call / gate run.
  ctx.commands.register({
    name: "df-profile",
    description: "Change the enforcement profile (off, advisory, standard, strict).",
    input: { hint: "<off|advisory|standard|strict>" },
    handler: async (invocation) => {
      try {
        const raw = invocation.rawInput.trim().toLowerCase();
        if (raw !== "off" && raw !== "advisory" && raw !== "standard" && raw !== "strict") {
          return {
            kind: "error",
            text: `Unknown profile "${invocation.rawInput.trim()}". Use one of: off, advisory, standard, strict.`,
          };
        }
        await reloadConfigIfChanged(state);
        const text = await changeProfile(state.directory, raw);
        return { kind: "success", text };
      } catch (error) {
        return { kind: "error", text: `df-profile failed: ${(error as Error)?.message ?? error}` };
      }
    },
  });

  // Project setup: deterministic half in code (scaffold templates,
  // detected config, trial-run, wizard brief), judgment half handed to
  // the agent via `followup` — the DSH-native shape of opencode's
  // `session.prompt` handoff (same pattern as operator-memory's
  // `operator-project-init`). Safe to re-run; reports status when
  // already configured.
  ctx.commands.register({
    name: "df-init",
    description:
      "Set up opencode-dev-framework for the current project: scaffold templates, write the detected config, trial-run it, and hand the brief to the agent. Safe to re-run; reports status when already configured.",
    handler: async (invocation) => {
      try {
        invocation.signal?.throwIfAborted();
        await reloadConfigIfChanged(state);
        const delivered = await runInitCommand({
          directory: state.directory,
          run,
          delivery: undefined,
          checkAlive: () => invocation.signal?.throwIfAborted(),
          reload: async () => {
            clearConfigCache();
            const newConfig = loadConfig(state.directory);
            const { constitution: newConstitution } = await loadConstitution(
              newConfig,
              state.directory,
            );
            state.config = newConfig;
            state.constitution = newConstitution;
            for (const name of [".opencode-dev-framework.yml", ".dev-framework.yml"]) {
              try {
                state.configMtime = (await stat(join(state.directory, name))).mtimeMs;
                break;
              } catch {
                // continue to fallback name
              }
            }
          },
          deliver: async (text) => {
            const followup = invocation.agent.followup;
            if (typeof followup !== "function") {
              // Core converts a delivery throw into a precise
              // scaffold-succeeded-but-handoff-failed error (init.ts).
              throw new Error(
                "df-init: the host agent has no followup seam; setup brief could not be handed off",
              );
            }
            followup(dshUserMessage(text));
          },
          note: async (level, message, extra) => {
            await safeLog(state, level, message, extra);
          },
        });
        if (!delivered) {
          return { kind: "success", text: "df-init: project already configured and clean." };
        }
        return {
          kind: "success",
          text: "df-init: scaffold complete; setup brief handed to the session.",
        };
      } catch (error) {
        return { kind: "error", text: `df-init failed: ${(error as Error)?.message ?? error}` };
      }
    },
  });

  // Template refresh: drift check (read-only), handoff when drift needs
  // an agent. Mirrors opencode's `/df-update` with a `followup` handoff
  // instead of `session.prompt`.
  ctx.commands.register({
    name: "df-update",
    description:
      "Check for template drift between the deployed project files and the shipped set; hands the refresh list to the agent when drift needs attention. Read-only; safe to re-run.",
    handler: async (invocation) => {
      try {
        invocation.signal?.throwIfAborted();
        await reloadConfigIfChanged(state);
        const delivered = await runUpdateCommand({
          directory: state.directory,
          delivery: undefined,
          checkAlive: () => invocation.signal?.throwIfAborted(),
          deliver: async (text) => {
            const followup = invocation.agent.followup;
            if (typeof followup !== "function") {
              // Core converts a delivery throw into a precise
              // refreshed-but-handoff-failed error (update.ts).
              throw new Error(
                "df-update: the host agent has no followup seam; refresh handoff could not be delivered",
              );
            }
            followup(dshUserMessage(text));
          },
        });
        if (!delivered) {
          return { kind: "success", text: "df-update: templates current, nothing to do." };
        }
        return {
          kind: "success",
          text: "df-update: drift detected; refresh list handed to the session.",
        };
      } catch (error) {
        return { kind: "error", text: `df-update failed: ${(error as Error)?.message ?? error}` };
      }
    },
  });

  // Agent-invokable tools: the same four `dev_framework_*` tools the
  // OpenCode adapter installs, over the same core functions. Definitions
  // are plain objects in the host's compiled `defineTool` shape (JSON
  // Schema parameters, canonical string value schema with a text
  // renderer) — see `DshToolDefinition`. Each registration is isolated:
  // a host that rejects one definition still gets the rest.
  registerDshTool(ctx, state, {
    name: "dev_framework_verify",
    description:
      "Run the full opencode-dev-framework completion contract now (typecheck, tests, changed-file lint, peer-review state) and return the summary. The first line is DEV_FRAMEWORK_VERDICT: PASS or FAIL, reporting the raw inspection outcome. Use for a mid-session gate check without waiting for turn-stopping; unlike the gate this never steers, it only reports.",
    parameters: {
      type: "object",
      properties: {
        directory: {
          type: "string",
          description: "Project directory (defaults to current project)",
        },
      },
      additionalProperties: false,
    },
    isConcurrencySafe: () => true,
    execute: async (input: unknown) => {
      const args = input as { directory?: string };
      const targetDir = args.directory ?? state.directory;
      const liveState = getActiveState();
      const live = liveState !== null && liveState.directory === targetDir ? liveState : null;
      const own = state.directory === targetDir ? state : null;
      const holder = live ?? own;
      // Live tracker's changed files beat the empty default: a mid-session
      // verify scopes `changed` steps to real edits (mirror of opencode).
      const cfg = holder?.config ?? loadConfig(targetDir);
      const changed = holder !== null ? holder.tracker.getChangedFiles() : [];
      const { summary } = await verifyGate(run, targetDir, cfg, changed);
      return summary;
    },
  });

  registerDshTool(ctx, state, {
    name: "dev_framework_set_profile",
    description:
      "Change the opencode-dev-framework profile (off, advisory, standard, strict) for the current project and apply it immediately.",
    parameters: {
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
    execute: async (input: unknown) => {
      const args = input as { profile: string; directory?: string };
      const targetDir = args.directory ?? state.directory;
      const profile = args.profile.trim().toLowerCase();
      const valid = ["off", "advisory", "standard", "strict"] as const;
      if (!(valid as readonly string[]).includes(profile)) {
        return `Invalid profile "${args.profile}". Valid values: ${valid.join(", ")}.`;
      }
      const message = await changeProfile(targetDir, profile as Profile);
      clearConfigCache();
      const newConfig = loadConfig(targetDir);
      const { constitution: newConstitution } = await loadConstitution(newConfig, targetDir);
      if (state.directory === targetDir) {
        state.config = newConfig;
        state.constitution = newConstitution;
      }
      const liveState = getActiveState();
      if (liveState !== null && liveState !== state && liveState.directory === targetDir) {
        liveState.config = newConfig;
        liveState.constitution = newConstitution;
      }
      return `${message} Change applied immediately.`;
    },
  });

  registerDshTool(ctx, state, {
    name: "dev_framework_status",
    description:
      "Show the current opencode-dev-framework state for the project: active profile, guardrails, completion gate, on-edit behavior, tracked changed files, and block counts.",
    parameters: {
      type: "object",
      properties: {
        directory: {
          type: "string",
          description: "Project directory (defaults to current project)",
        },
      },
      additionalProperties: false,
    },
    isConcurrencySafe: () => true,
    execute: async (input: unknown) => {
      const args = input as { directory?: string };
      const targetDir = args.directory ?? state.directory;
      const liveState = getActiveState();
      const live = liveState !== null && liveState.directory === targetDir ? liveState : null;
      const own = state.directory === targetDir ? state : null;
      const holder = live ?? own;
      const cfg = holder?.config ?? loadConfig(targetDir);
      // Nullable like the OpenCode tool: a foreign directory renders
      // config-only instead of misattributing our tracker data to it.
      return renderStatus(cfg, holder);
    },
  });

  registerDshTool(ctx, state, {
    name: "dev_framework_init",
    description:
      "Scaffold opencode-dev-framework project files (agents, skills, commands, default config) into the current project. Missing files are created; existing files are skipped unless overwrite is true. With wizard:true, appends a wizard brief (detection, trial-run, Makefile targets, open questions) when the scaffold changed anything, or a status note when already configured.",
    parameters: {
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
        wizard: {
          type: "boolean",
          description: "Append a wizard brief for agent-led handoff to the project-config skill",
        },
      },
      additionalProperties: false,
    },
    execute: async (input: unknown) => {
      const args = input as { directory?: string; overwrite?: boolean; wizard?: boolean };
      const targetDir = args.directory ?? state.directory;
      const scaffold = await runInitScaffold(targetDir, run, {
        wizard: args.wizard,
        overwrite: args.overwrite,
      });
      return scaffoldReportLines(scaffold, targetDir).join("\n");
    },
  });
}
