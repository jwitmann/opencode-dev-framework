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

import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createBlockStore, createStuckSnapshotStore } from "../../core/block-store.js";

import { changeProfile, verifyGate } from "../../core/commands.js";
import { CONFIG_FILE_PRECEDENCE, clearConfigCache, loadConfig } from "../../core/config.js";
import { renderHelp, renderRuntimeStatus, renderStatus } from "../../core/format-status.js";
import { createChangedFileTracker } from "../../core/gate.js";
import {
  buildVerifiedObjective,
  checkGoalAvailability,
  isNativeGoalListed,
} from "../../core/goal.js";
import {
  artifactStateFirst,
  childArtifactDenial,
  createPassCache,
  isReviewArtifact,
  preflightBlockReason,
} from "../../core/harness.js";
import { runInitCommand, runInitScaffold, scaffoldReportLines } from "../../core/init.js";
import { DSH_SKILL_ROOTS } from "../../core/installer.js";
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
import { PREFLIGHT_RELS } from "../../core/paths.js";
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
import {
  checkTemplateUpdates,
  composeUpdatePrompt,
  driftMentionLine,
  needsAgentHandoff,
  runUpdateCommand,
} from "../../core/update.js";
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

/**
 * Formatter attribution for DSH status surfaces: the adapter (not host
 * core) runs format-then-lint in post-execute. One site (the `df-status`
 * command) passes `formatOwner: "adapter"`; the agent-tool status path
 * renders through the same handler shape.
 */
const DSH_FORMAT_OWNER = "adapter" as const;

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
  /**
   * Host session-event id. The host commits these messages as
   * user/message session events and its resume validator requires a
   * non-empty `data.id` on every message event — an id-less message
   * poisons the log for the next resume. Always stamped by
   * `dshUserMessage()`; optional here so hand-built messages still
   * compile, but never omit it on the wire.
   */
  id?: string;
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

/** Minimal structural face of the host agent-preset registry (plan 26). */
export interface DshAgentPresets {
  register(definition: {
    id: string;
    name?: string;
    description?: string;
    plugins: Array<{ id?: string; name: string; config?: unknown }>;
  }): Promise<unknown>;
}

/** Minimal structural face of the host subagent service (plan 26). */
export interface DshSubagents {
  getProvider(name: string):
    | {
        name: string;
        /**
         * Start-request capabilities the provider honors. Read once per
         * dispatch (plan 27): the host rejects a request needing an
         * unsupported capability, so the adapter only sends what the
         * provider for this start supports. Absent on older hosts —
         * absence degrades to the capability-less (text-only) path.
         */
        capabilities?: {
          agentOptions?: boolean;
          agentPreset?: boolean;
          outputSchema?: boolean;
          depthLimit?: boolean;
        };
      }
    | undefined;
  resolveMaxDepth(value: unknown): unknown;
  startActivation(request: {
    provider: string;
    label: string;
    name?: string;
    prompt: Array<{ type: "text"; text: string }>;
    parent: unknown;
    agentPreset?: string;
    /**
     * Structured-findings schema (plan 27): object-rooted, within the
     * host's enforced subset. Sent only after a positive capability
     * probe — the host rejects the start otherwise.
     */
    outputSchema?: unknown;
    maxDepth?: unknown;
    signal?: AbortSignal;
    delivery: "parent";
  }): Promise<{ name: string }>;
}

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
  /**
   * Subagent service for specialist dispatch (plan 26). Optional like
   * `tools`/`goals`: the host throws on reading a non-injected service,
   * so every read is guarded and absence degrades to inline review.
   */
  readonly subagents?: DshSubagents;
  /**
   * Agent-preset registry for the read-only reviewer preset (plan 26.3).
   * Same guarded-read contract: absence degrades to spawning without a
   * preset (prompt-level restriction + per-exec guards).
   */
  readonly agentPresets?: DshAgentPresets;
  /**
   * User-approval seam. Optional like `tools`/`goals`: the host throws on
   * reading a non-injected service, so every read is guarded and absence
   * degrades to allow+log. Declared structurally (no host import).
   */
  readonly approval?: unknown;
  /**
   * Session-history query service for the continuity probe (plan 27).
   * Optional like the other services; resolved via `get` where present
   * so no bundle inject change is needed, with guarded property read
   * as the fallback. Absence degrades to unknown continuity.
   */
  readonly sessionQuery?: unknown;
  /**
   * Optional service lookup on the sandbox facade: never throws for
   * absent services (unlike undeclared property reads), so probing an
   * unmounted service degrades silently instead of reporting failure.
   */
  readonly get?: (name: string) => unknown;
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
  const override = env.ODF_WORKDIR;
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
  // The host throws on reading a non-injected service (rather than
  // yielding undefined), so the read itself is guarded: a host without
  // the service keeps every command, exactly as documented. The service
  // object (not the bare method) is captured so the `register` call
  // keeps its receiver — the host implementation reads `this`.
  let tools: DshTools | undefined;
  try {
    tools = ctx.tools;
  } catch {
    tools = undefined;
  }
  if (typeof tools?.register !== "function") {
    void safeLog(state, "warn", `tool service unavailable; skipping agent tool ${def.name}`);
    return;
  }
  try {
    tools.register({
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
      execute: (args: unknown, exec: unknown) => {
        // Review duty belongs to the top-level session (plan 23): a child
        // that invokes a gate tool gets a denial with the redirect, never
        // a gate evaluation for the shared tree. Investigation-only by
        // construction, even where the child roster lists these tools.
        const agent = (exec as { agent?: DshAgent } | null | undefined)?.agent;
        if (isChildAgent(agent)) {
          const denial =
            `Child sessions may not invoke ${def.name}: the review duty belongs ` +
            "to the top-level session — report findings back as text and let the " +
            "parent run the gate.";
          void safeLog(state, "warn", denial, { tool: def.name });
          return Promise.resolve(denial);
        }
        return def.execute(args);
      },
    });
  } catch (error) {
    void safeLog(state, "warn", `agent tool ${def.name} rejected by host; commands still work`, {
      error: String((error as Error)?.message ?? error),
    });
  }
}

/**
 * Whether a host service exposes a given method. Guarded read (same idiom
 * as every other seam probe): the host throws without inject, and absence
 * degrades to false. Used once at mount for the status seams snapshot.
 */
function hasServiceMethod(read: () => unknown, method: string): boolean {
  try {
    const service = read() as Record<string, unknown> | null | undefined;
    return typeof service?.[method] === "function";
  } catch {
    return false;
  }
}

/**
 * Whether a guard `warn` can reach the human as an `ask` decision. Guarded
 * read (same idiom as the tool/goal services): the host throws without
 * inject, and absence means allow+log. Child sessions never ask — a child
 * reports back and the parent decides (the host rejects child questions
 * anyway); the caller ANDs this with `!isChildAgent(exec.agent)`.
 */
function canAskUser(ctx: DshContext): boolean {
  try {
    // Services are objects here (`subprocess`, `commands`, `tools`,
    // `goals`); accept a callable too so a future function-shaped mount
    // still reaches the human instead of silently degrading.
    const approval = ctx.approval as unknown;
    return approval !== null && (typeof approval === "object" || typeof approval === "function");
  } catch {
    return false;
  }
}

function toPreDecision(result: GuardResult, askAvailable: boolean): DshPreDecision {
  // Intent over mechanism: a `warn` is the framework asking the human, not
  // a log line. Where the host exposes a user-approval seam (the
  // interactive TUI mounts it with human answerers), emit `ask` so the
  // human actually gets the question. Where the seam is absent (agent-run
  // headless: the read throws without inject), allow with a warn log —
  // exactly like the OpenCode adapter. Emitting `ask` with no answerers
  // would fail closed and convert advisory warnings into blocks, the
  // opposite of the warn contract. (`cancel` stays unused: nothing in the
  // framework asks the model to stand down, only the human to decide.)
  if (result.decision !== "deny") {
    if (result.decision === "warn" && askAvailable) {
      // Fallback literal mirrors the deny armor below: core `enforce()`
      // always sets `reason`, but a reason-less `ask` must still read
      // as a request, never as an empty prompt.
      return { kind: "ask", reason: result.reason ?? "review requested by guardrails" };
    }
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
  return {
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
    id: randomUUID(),
  };
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

/**
 * Continuity of the current process against the session's durable log
 * (plan 27): whether the host's resume path marked an interrupted tail.
 * `unknown` is the honest default — absence of evidence, never evidence
 * of cleanliness. The probe never changes a gate verdict; it only names
 * the state `df-status` reports.
 */
type ContinuityState = "clean" | "resumed-interrupted" | "unknown";

/** Closed-vocabulary `df-status` rendering for a continuity state. */
function renderContinuity(state: ContinuityState): string {
  if (state === "clean") {
    return "Continuity (this session): clean — session log shows no interrupted turn";
  }
  if (state === "resumed-interrupted") {
    return (
      "Continuity (this session): resumed after interruption — prior gate state " +
      "is unknown; the gate re-verifies from scratch"
    );
  }
  return (
    "Continuity (this session): unknown — continuity could not be established; " +
    "the gate re-verifies from scratch"
  );
}

/**
 * Resolve the session-history query service without a bundle inject
 * change: the sandbox facade's optional `get` never throws for absent
 * services, and the guarded property read covers hosts that inject it
 * directly. Returns null when the seam is unavailable — never throws.
 */
function readSessionQuery(ctx: DshContext): { readSession?: unknown } | null {
  try {
    if (typeof ctx.get === "function") {
      const viaGet = ctx.get("sessionQuery") as Record<string, unknown> | null | undefined;
      if (viaGet !== null && viaGet !== undefined) {
        return viaGet as { readSession?: unknown };
      }
    }
  } catch {
    // Fall through to the property read below.
  }
  try {
    const direct = ctx.sessionQuery as Record<string, unknown> | null | undefined;
    if (direct !== null && direct !== undefined) {
      return direct as { readSession?: unknown };
    }
  } catch {
    // Absent seam: the caller reports unknown.
  }
  return null;
}

/** True when a raw session-log event closes a turn as interrupted. */
function isInterruptedTurnEnd(event: unknown): boolean {
  if (event === null || typeof event !== "object") return false;
  const record = event as { type?: unknown; data?: unknown };
  if (record.type !== "turn/end") return false;
  const data = record.data as { reason?: unknown } | null | undefined;
  const reason = data?.reason as { kind?: unknown } | null | undefined;
  return reason?.kind === "interrupted";
}

/**
 * Probe continuity once per session per process (plan 27). Fallback
 * turn-number identities carry no session to query, so they report
 * unknown without touching the seam. Every failure — absent seam,
 * throwing query, uninterpretable log — reports unknown and logs at
 * debug. Never throws; never changes a gate verdict.
 */
async function probeContinuity(
  ctx: DshContext,
  state: HookState,
  sessionID: string,
): Promise<ContinuityState> {
  if (sessionID.startsWith("turn-")) {
    return "unknown";
  }
  const query = readSessionQuery(ctx);
  if (query === null || typeof query.readSession !== "function") {
    await safeLog(state, "debug", "continuity probe skipped: no sessionQuery seam", {
      sessionID,
    });
    return "unknown";
  }
  try {
    const snapshot = (await (
      query.readSession as (sessionID: string) => Promise<{ events?: unknown }>
    )(sessionID)) as { events?: unknown } | null | undefined;
    if (!Array.isArray(snapshot?.events)) {
      // A malformed payload is neither an empty log nor evidence: the
      // spec's uninterpretable-log rule reports unknown.
      await safeLog(state, "debug", "continuity probe uninterpretable (unknown)", {
        sessionID,
      });
      return "unknown";
    }
    const interrupted = snapshot.events.some(isInterruptedTurnEnd);
    const result: ContinuityState = interrupted ? "resumed-interrupted" : "clean";
    await safeLog(state, "debug", `continuity probe: ${result}`, { sessionID });
    return result;
  } catch (error) {
    await safeLog(
      state,
      "debug",
      `continuity probe failed (unknown): ${(error as Error)?.message ?? error}`,
      {
        sessionID,
      },
    );
    return "unknown";
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
 * Specialist dispatch (plan 26). The read-only reviewers dispatched at
 * review-blocks: pattern-guardian first (slice 26.2), style-enforcer and
 * code-reviewer joining in 26.3. test-grounder stays a lead duty — it
 * executes the project's own verify commands, which needs an
 * execution-capable context, not a read-only child.
 */
const SPECIALIST_KINDS = ["pattern-guardian", "style-enforcer", "code-reviewer"] as const;

type SpecialistKind = (typeof SPECIALIST_KINDS)[number];

/** Name stems for adapter-spawned specialist children (host limit: ≤32 chars). */
const SPECIALIST_NAME_STEMS: Record<SpecialistKind, string> = {
  "pattern-guardian": "odf-pattern-guardian",
  "style-enforcer": "odf-style-enforcer",
  "code-reviewer": "odf-code-reviewer",
};

/**
 * Read-only reviewer preset (plan 26.3): the exact toolset every
 * specialist child runs under. Registered by the adapter itself at
 * apply time — no profile-owner step. Reads + search only: no writes,
 * no exec, no delegation (a child can neither edit nor spawn).
 */
const REVIEWER_PRESET_ID = "odf-reviewer";

function reviewerPresetDefinition(): {
  id: string;
  name: string;
  description: string;
  plugins: Array<{ id: string; name: string; config: unknown }>;
} {
  return {
    id: REVIEWER_PRESET_ID,
    name: "ODF Reviewer",
    description:
      "Read-only review tools for ODF specialist children: filesystem reads and search. No writes, no exec, no delegation.",
    plugins: [
      {
        id: "odf-reviewer-fs",
        name: "@deepseek-ai/dsh-tool-fs",
        config: { read: true, readImage: true, write: false, edit: false, applyPatch: false },
      },
      {
        id: "odf-reviewer-search",
        name: "@deepseek-ai/dsh-tool-fs-search",
        config: { sampleOverCapGlobResults: false },
      },
    ],
  };
}

/**
 * Completion-notice shape, verified live (plan 26 slice 26.1): the
 * delivery-to-parent notice names the finished child and quotes its
 * closing message.
 */
const SPECIALIST_NOTICE_RE =
  /Background subagent ([a-z0-9][a-z0-9-]*) finished[\s\S]*?[Ii]ts closing message:\s*([\s\S]*?)\s*$/;

/**
 * Structured-findings schema (plan 27): what a specialist child reports
 * through the host's capture tool when the provider supports
 * `outputSchema`. Object-rooted and keyword-minimal (`type` / `properties`
 * / `required` / `additionalProperties` / `items` / `enum`) so it stays
 * inside the host's enforced subset — the host rejects the start
 * otherwise. Closed (`additionalProperties: false`) so a drifting child
 * fails validation loudly instead of smuggling extra fields past the
 * fold.
 */
export const SPECIALIST_FINDINGS_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          line: { type: "integer" },
          issue: { type: "string" },
          severity: { type: "string", enum: ["blocking", "should-fix", "note"] },
        },
        required: ["file", "issue", "severity"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "findings"],
  additionalProperties: false,
} as const;

/** Notice-block prefix the host prepends to a satisfied structured result. */
const SPECIALIST_STRUCTURED_RESULT_PREFIX = "Structured result:";

/** Severities the fold accepts; anything else is coerced to `note` (see below). */
const SPECIALIST_FINDING_SEVERITIES = new Set(["blocking", "should-fix", "note"]);

/** Maximum structured findings folded into one steer; the tail names the rest. */
const MAX_STRUCTURED_FINDINGS = 20;

/** Maximum folded summary length; longer summaries are truncated, not dropped. */
const MAX_STRUCTURED_SUMMARY_CHARS = 2000;

/**
 * Structured findings out of one entering text, or null. Prefers the
 * host-rendered `Structured result:` block (exact JSON the child
 * submitted, already schema-validated by the provider). Malformed JSON,
 * wrong shape, or zero usable entries all return null so the caller
 * falls back to the closing-message regex — structure is an upgrade,
 * never a new failure mode.
 */
export function extractStructuredFindings(text: string): string[] | null {
  const at = text.indexOf(SPECIALIST_STRUCTURED_RESULT_PREFIX);
  if (at === -1) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(at + SPECIALIST_STRUCTURED_RESULT_PREFIX.length).trim());
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const { summary, findings } = parsed as { summary?: unknown; findings?: unknown };
  if (typeof summary !== "string" || !Array.isArray(findings)) {
    return null;
  }
  const lines: string[] = [];
  for (const entry of findings) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const { file, line, issue, severity } = entry as Record<string, unknown>;
    if (typeof file !== "string" || file === "" || typeof issue !== "string" || issue === "") {
      continue;
    }
    // Unknown severities coerce to `note` rather than dropping the entry:
    // a typo must never silently lose a finding, and the gate still blocks
    // on the missing review artifact, so nothing is smuggled past enforcement.
    const level =
      typeof severity === "string" && SPECIALIST_FINDING_SEVERITIES.has(severity)
        ? severity
        : "note";
    const where = typeof line === "number" && Number.isInteger(line) && line >= 1 ? `:${line}` : "";
    lines.push(`- [${file}${where}] ${issue} (${level})`);
  }
  if (lines.length === 0) {
    return null;
  }
  const headline =
    summary.trim() === "" ? "(no summary)" : summary.trim().slice(0, MAX_STRUCTURED_SUMMARY_CHARS);
  const folded = [`${headline}`, ...lines];
  if (lines.length > MAX_STRUCTURED_FINDINGS) {
    const kept = lines.slice(0, MAX_STRUCTURED_FINDINGS);
    const omitted = lines.length - MAX_STRUCTURED_FINDINGS;
    return [`${headline}`, ...kept, `(findings omitted for ${omitted} more entries)`];
  }
  return folded;
}

/** Read-only investigation brief when the agent file is unreadable. */
const SPECIALIST_FALLBACK_BRIEF =
  "You are the pattern-guardian: check the changed files below against the " +
  "codebase's existing patterns (duplication, re-invented helpers, divergent " +
  "conventions, unjustified new dependencies). Report findings as text; do " +
  "not edit anything.";

/** Brief source chain (plan 26.3): neutral override first so a DSH-only
 * project never needs OpenCode's home; the shipped OpenCode home second
 * (single source both harnesses edit); embedded fallback last. Never throws. */
const SPECIALIST_BRIEF_RELS = [".dev-framework/agents", ".opencode/agents"] as const;

/** Load the specialist brief: neutral override, OpenCode home, fallback. */
async function loadSpecialistBrief(kind: string, directory: string): Promise<string> {
  for (const rel of SPECIALIST_BRIEF_RELS) {
    try {
      return await readFile(join(directory, rel, `${kind}.md`), "utf8");
    } catch {
      // Next brief source.
    }
  }
  return SPECIALIST_FALLBACK_BRIEF;
}

/** Best-effort text of one entering message (any shape, never throws). */
function enteringMessageText(message: unknown): string | null {
  if (typeof message !== "object" || message === null) {
    return null;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const part of content) {
    if (
      typeof part === "object" &&
      part !== null &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      parts.push((part as { text: string }).text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
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
    // Probed once at mount so `df-status` reads degraded mounts as
    // degraded. Never throws: every seam degrades to false.
    seams: {
      tools: hasServiceMethod(() => ctx.tools, "register"),
      goals: hasServiceMethod(() => ctx.goals, "create"),
      approval: canAskUser(ctx),
      subagents: hasServiceMethod(() => ctx.subagents, "startActivation"),
      agentPresets: hasServiceMethod(() => ctx.agentPresets, "register"),
      sessionQuery: hasServiceMethod(() => readSessionQuery(ctx), "readSession"),
    },
  };
  setActiveState(state);
  // Runtime snapshot for `df-runtime` (fire-and-forget, never throws):
  // "armed" until a gate evaluation reports otherwise.
  stampRuntimeStatus(state.directory, "turn-stopping", "armed", DSH_SKILL_ROOTS[0]);

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

  // Continuity probe results (plan 27): one entry per session per
  // process, holding the in-flight promise so concurrent callers share
  // it. A fresh process re-verifies from scratch, so the map only ever
  // names what this process observed — never a durable receipt.
  const continuityBySession = new Map<string, Promise<ContinuityState>>();

  /**
   * Lazily assess continuity for a session, memoizing per session id.
   * The memoized unit is the in-flight promise, so concurrent callers
   * (a stopping evaluation racing a status check) share one query.
   * Total: even a throwing logger degrades to unknown instead of
   * rejecting into the stopping path or the status handler.
   */
  async function ensureContinuity(sessionID: string): Promise<ContinuityState> {
    // Fallback identities name no session: report without memoizing, so
    // id-less call sites neither accumulate entries nor share results.
    if (sessionID.startsWith("turn-")) {
      return "unknown";
    }
    const known = continuityBySession.get(sessionID);
    if (known !== undefined) {
      return known;
    }
    const pending = probeContinuity(ctx, state, sessionID).catch((): ContinuityState => "unknown");
    continuityBySession.set(sessionID, pending);
    return pending;
  }

  // Specialist dispatch (plan 26): children the adapter spawned per
  // session and kind (at most one pending per kind — a new block while
  // one is outstanding reuses it instead of fanning out) and findings
  // collected per session. Findings fold into the next gate steer
  // exactly once, then clear, so a later block never steers a stale copy.
  const dispatchedSpecialists = new Map<string, Map<SpecialistKind, string>>();
  const specialistFindings = new Map<string, string[]>();
  let specialistCounter = 0;
  // Whether the read-only reviewer preset registered (plan 26.3). Set
  // asynchronously at apply; spawn reads it at dispatch time, so an
  // early block simply spawns preset-less and degrades gracefully.
  let reviewerPresetReady = false;

  // Fire-and-forget: the adapter ships its own reviewer preset — no
  // profile-owner step. Duplicate registration means our deterministic
  // definition is already live (HMR re-apply), which also counts as
  // ready. Any other failure degrades to preset-less spawning.
  void (async () => {
    let presets: DshAgentPresets | undefined;
    try {
      presets = ctx.agentPresets;
    } catch (error) {
      await safeLog(
        state,
        "debug",
        `reviewer preset skipped (no agentPresets seam): ${(error as Error)?.message ?? error}`,
      );
      return;
    }
    if (typeof presets?.register !== "function") {
      await safeLog(state, "debug", "reviewer preset skipped: agentPresets.register unavailable");
      return;
    }
    try {
      await presets.register(reviewerPresetDefinition());
      reviewerPresetReady = true;
      await safeLog(state, "info", `reviewer preset registered: ${REVIEWER_PRESET_ID}`);
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      if (message.includes("Duplicate agent preset")) {
        reviewerPresetReady = true;
        await safeLog(state, "debug", `reviewer preset already live: ${REVIEWER_PRESET_ID}`);
      } else {
        await safeLog(
          state,
          "warn",
          `reviewer preset unavailable (prompt-level restriction only): ${message}`,
        );
      }
    }
  })();

  function pendingSpecialist(sessionKey: string, kind: SpecialistKind): string | undefined {
    return dispatchedSpecialists.get(sessionKey)?.get(kind);
  }

  function trackSpecialist(sessionKey: string, kind: SpecialistKind, name: string): void {
    let kinds = dispatchedSpecialists.get(sessionKey);
    if (kinds === undefined) {
      kinds = new Map();
      dispatchedSpecialists.set(sessionKey, kinds);
    }
    kinds.set(kind, name);
  }

  /** Dispatch one specialist child; null when the seam is absent/fails. */
  async function spawnSpecialist(
    sessionKey: string,
    kind: SpecialistKind,
    agent: DshAgent,
    changedFiles: string[],
    gateSummary: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    let subagents: DshSubagents | undefined;
    try {
      subagents = ctx.subagents;
    } catch {
      subagents = undefined;
    }
    if (typeof subagents?.startActivation !== "function") {
      return null;
    }
    // Capability probe (plan 27): `outputSchema` is per-provider — the
    // host rejects a start that needs an unsupported capability, so probe
    // the exact provider this start will use and degrade to the
    // closing-text path on any doubt (absent seam, unknown provider,
    // throwing probe). Never throws out of dispatch.
    let structuredCapable = false;
    try {
      structuredCapable = subagents.getProvider("spawn")?.capabilities?.outputSchema === true;
    } catch {
      structuredCapable = false;
    }
    try {
      specialistCounter += 1;
      const name = `${SPECIALIST_NAME_STEMS[kind]}-${specialistCounter}`;
      const brief = await loadSpecialistBrief(kind, state.directory);
      const prompt =
        `${brief}\n\nYou are investigating, not implementing: report findings ` +
        `as text, do not edit anything.\nChanged files under review:\n` +
        `${changedFiles.map((file) => `- ${file}`).join("\n")}\n\n` +
        `Gate summary for this block:\n${gateSummary}` +
        (structuredCapable
          ? `\n\nAlso report each finding with the structured-output tool ` +
            `(one entry per finding), then close with a short text summary as usual.`
          : "");
      const activation = await subagents.startActivation({
        provider: "spawn",
        label: `odf specialist review (${kind})`,
        name,
        prompt: [{ type: "text", text: prompt }],
        parent: agent,
        ...(reviewerPresetReady ? { agentPreset: REVIEWER_PRESET_ID } : {}),
        ...(structuredCapable ? { outputSchema: SPECIALIST_FINDINGS_SCHEMA } : {}),
        ...(signal !== undefined ? { signal } : {}),
        delivery: "parent",
      });
      trackSpecialist(sessionKey, kind, activation.name);
      await safeLog(
        state,
        "info",
        `specialist dispatched: ${activation.name} (${structuredCapable ? "structured" : "text"} findings)`,
        {
          sessionID: sessionKey,
        },
      );
      return activation.name;
    } catch (error) {
      await safeLog(
        state,
        "warn",
        `specialist spawn failed (inline review continues): ${(error as Error)?.message ?? error}`,
      );
      return null;
    }
  }

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
          ? (exec.arguments as Record<string, unknown>).input
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
        const artifact = await artifactStateFirst(state.directory, PREFLIGHT_RELS);
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
          return toPreDecision(verdict, canAskUser(ctx) && !isChildAgent(exec.agent));
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
            return toPreDecision(fileVerdict, canAskUser(ctx) && !isChildAgent(exec.agent));
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
          return toPreDecision(verdict, canAskUser(ctx) && !isChildAgent(exec.agent));
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
          ? (execArgs as Record<string, unknown>).input
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
      // Specialist findings (plan 26): a completion notice for a child
      // this adapter dispatched carries its closing message as review
      // evidence. Collect per session; the next gate block folds the
      // findings into its steer and clears them. Notices for children
      // the adapter did not dispatch are ignored. Scanned before the
      // injection early-return: findings arrive on later steps, after
      // the session is already injected.
      {
        const pending = dispatchedSpecialists.get(key);
        if (pending !== undefined && pending.size > 0) {
          for (const message of messages) {
            const text = enteringMessageText(message);
            if (text === null) {
              continue;
            }
            const match = SPECIALIST_NOTICE_RE.exec(text);
            if (match === null) {
              continue;
            }
            const finished = match[1];
            if (![...pending.values()].includes(finished)) {
              continue;
            }
            // The child finished: consume its kind slot whether or not
            // it reported anything, so a silent child never wedges
            // future blocks. Empty closings fold nothing.
            for (const [kind, childName] of pending) {
              if (childName === finished) {
                pending.delete(kind);
              }
            }
            const finding = (match[2] ?? "").trim();
            // Structured first (plan 27): when the child satisfied its
            // output schema, the notice carries a `Structured result:`
            // block — exact submitted JSON beats the quoted closing prose.
            // Null (absent/malformed/empty) falls back to the closing
            // text, preserving the pre-structured behavior verbatim.
            const structuredLines = extractStructuredFindings(text);
            const folded = structuredLines ?? (finding !== "" ? [finding] : []);
            if (folded.length > 0) {
              const collected = specialistFindings.get(key) ?? [];
              collected.push(
                `[${finished}] ${structuredLines !== null ? "(structured) " : ""}${folded.join("\n")}`,
              );
              specialistFindings.set(key, collected);
              await safeLog(
                state,
                "info",
                `specialist findings collected: ${finished} (${structuredLines !== null ? "structured" : "text"})`,
                {
                  sessionID: key,
                },
              );
            } else {
              await safeLog(state, "debug", `specialist finished silent: ${finished}`, {
                sessionID: key,
              });
            }
          }
        }
      }
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
        const line = driftMentionLine(
          await checkTemplateUpdates(state.directory, DSH_SKILL_ROOTS[0]),
        );
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
      const sessionID = sessionOf(agent, turn);
      // Continuity probe (plan 27): assessed once per session, before any
      // gate work, in every profile including off — it reports, never
      // gates. Awaited here (not fire-and-forget) so the first `df-status`
      // after a turn boundary already names the state.
      await ensureContinuity(sessionID);
      // Only a fully-off profile skips the gate: `protect_off` stands
      // down guardrails, not the completion contract — mirroring the
      // OpenCode idle gate, which never consults `protect_off`.
      if (isProfileOff(state)) {
        return;
      }
      const verdict = await runCompletion(state, sessionID);
      const message = await actOnVerdict(state, verdict);
      // Refresh the `df-runtime` snapshot: a block prevents termination and
      // continues the same turn ("idle" = gate failures continue the same
      // execution); pass and standdown leave the gate armed for the next turn.
      stampRuntimeStatus(
        state.directory,
        "turn-stopping",
        message === null ? "armed" : "idle",
        DSH_SKILL_ROOTS[0],
      );
      if (message === null) {
        return;
      }
      // Fold collected specialist findings (plan 26), then clear: each
      // finding steers exactly one block, never a stale copy.
      let steerText = message;
      const collected = specialistFindings.get(sessionID);
      if (collected !== undefined && collected.length > 0) {
        specialistFindings.delete(sessionID);
        steerText +=
          "\n\nSpecialist findings (incorporate before writing the review artifact):\n" +
          collected.join("\n");
      }
      // Dispatch specialists on review-blocks only (plan 26.3): the tree
      // is green and only the review duty is unmet — exactly the
      // reviewers' job. Gate-blocks (failing tests) need the lead to fix
      // code first; reviewing a red tree would burn child runs for
      // findings the gate already reports. Weakened blocks steer text
      // only. Advisory never dispatches — it warns instead of blocking.
      // At most one pending child per kind per session: a new block
      // while one is outstanding reuses the slot instead of fanning out.
      // Absent seam or spawn failure degrades to the inline steer.
      let specialistLine = "";
      if (
        verdict.decision === "blocked" &&
        verdict.reason === "review" &&
        (state.config.profile === "standard" || state.config.profile === "strict") &&
        state.seams?.subagents === true
      ) {
        const dispatched: string[] = [];
        for (const kind of SPECIALIST_KINDS) {
          if (pendingSpecialist(sessionID, kind) !== undefined) {
            continue;
          }
          const name = await spawnSpecialist(
            sessionID,
            kind,
            agent,
            state.tracker.getChangedFiles(),
            message,
            signal,
          );
          if (name !== null) {
            dispatched.push(name);
          }
        }
        if (dispatched.length > 0) {
          specialistLine =
            `\n\nSpecialist review dispatched (${dispatched.join(", ")}): their ` +
            "completion notices will arrive shortly — incorporate their findings " +
            "alongside this summary before writing the review artifact.";
        }
      }
      // Blocked: prevent termination by steering the gate summary into the
      // same turn. This is DSH's behavioral equivalent of the original
      // framework's stop-hook `decision: block`: the host awaits listeners,
      // then re-reads its inbox, and non-empty next-step work means the turn
      // cannot close. `followup` is only a degraded fallback when steering
      // is unavailable. Budget exhaustion is already a core `standdown`
      // verdict (no steer) — the adapter never counts blocks itself.
      const followup = dshUserMessage(steerText + specialistLine);
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
    description:
      "Show opencode-dev-framework gate status (profile, config, enforcement level) plus session continuity.",
    handler: async (invocation) => {
      // Continuity is session-scoped and the invoking agent names the
      // session; without an invocation there is nothing to assess.
      const agent = invocation?.agent as DshAgent | undefined;
      const continuity: ContinuityState =
        agent === undefined ? "unknown" : await ensureContinuity(sessionOf(agent, undefined));
      return {
        kind: "success",
        text: `${renderStatus(state.config, state, {
          formatOwner: DSH_FORMAT_OWNER,
        })}\n\n${renderContinuity(continuity)}`,
      };
    },
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

  // Command list: the `renderHelp` text is the DSH surface where the
  // OpenCode TUI would render the `/df-help` modal.
  ctx.commands.register({
    name: "df-help",
    description: "List the opencode-dev-framework commands.",
    handler: () => ({ kind: "success", text: renderHelp() }),
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
        // The host throws on reading a non-injected service, so the
        // read itself is guarded (same as the agent-tool registration).
        // The service object (not the bare method) is captured so the
        // `create` call keeps its receiver.
        let goals: DshGoals | undefined;
        try {
          goals = ctx.goals;
        } catch {
          goals = undefined;
        }
        if (typeof goals?.create !== "function") {
          return {
            kind: "error",
            text: "Cannot start a verified goal: the host goal service is not available on this core. Run the objective without verification where a goal service exists.",
          };
        }
        await goals.create(invocation.agent, { objective: built.text });
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
          // Setup intent: the scaffold must leave the agent able to load
          // the shipped skills through the host `skill` tool, so mirror
          // them into a scanned root and word the brief for host-native
          // tools (`skill` + `ask_user_question`).
          skillMirrorRoot: DSH_SKILL_ROOTS[0],
          skillAccess: "tool",
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
            for (const name of CONFIG_FILE_PRECEDENCE) {
              try {
                const mtimeMs = (await stat(join(state.directory, name))).mtimeMs;
                if (state.configMtime === undefined || mtimeMs > state.configMtime) {
                  state.configMtime = mtimeMs;
                }
              } catch {
                // name absent
              }
            }
          },
          deliver: async (text) => {
            // Receiver-preserving method call: a bare-function
            // extraction would drop a `this`-dependent host
            // implementation (same class as the tools.register fix).
            const agent = invocation.agent;
            if (typeof agent.followup !== "function") {
              // Core converts a delivery throw into a precise
              // scaffold-succeeded-but-handoff-failed error (init.ts).
              throw new Error(
                "df-init: the host agent has no followup seam; setup brief could not be handed off",
              );
            }
            agent.followup(dshUserMessage(text));
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
          // The init-time mirror is maintained, not fire-and-forget: a
          // missing or edited-out-of-sync skill copy reads as drift.
          skillMirrorRoot: DSH_SKILL_ROOTS[0],
          checkAlive: () => invocation.signal?.throwIfAborted(),
          deliver: async (text) => {
            // Receiver-preserving method call: a bare-function
            // extraction would drop a `this`-dependent host
            // implementation (same class as the tools.register fix).
            const agent = invocation.agent;
            if (typeof agent.followup !== "function") {
              // Core converts a delivery throw into a precise
              // refreshed-but-handoff-failed error (update.ts).
              throw new Error(
                "df-update: the host agent has no followup seam; refresh handoff could not be delivered",
              );
            }
            agent.followup(dshUserMessage(text));
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

  // Agent-invokable tools: the same `dev_framework_*` tools the
  // OpenCode adapter installs (verify, profile, status, init, update,
  // runtime), over the same core functions. Definitions
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
      return renderStatus(cfg, holder, {
        formatOwner: DSH_FORMAT_OWNER,
      });
    },
  });

  registerDshTool(ctx, state, {
    name: "dev_framework_init",
    description:
      "Scaffold opencode-dev-framework project files (agents, skills, commands, default config) into the current project, mirroring skills into the host-scanned skill root. Missing files are created; existing files are skipped unless overwrite is true. With wizard:true, appends a wizard brief (detection, trial-run, Makefile targets, open questions) when the scaffold changed anything, or a status note when already configured.",
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
        // Same kick-start contract as the `df-init` command: the agent
        // must be able to load the skills through the host `skill` tool.
        skillMirrorRoot: DSH_SKILL_ROOTS[0],
      });
      return scaffoldReportLines(scaffold, targetDir).join("\n");
    },
  });

  registerDshTool(ctx, state, {
    name: "dev_framework_update",
    description:
      "Check the framework deployment for drift (bundled templates and the host-scanned skill mirror) and return the per-file refresh/add brief. Use when the setup may be stale; present each file for review before editing, exactly like df-update, and never commit unreviewed.",
    parameters: {
      type: "object",
      properties: {
        directory: {
          type: "string",
          description: "Target project directory (defaults to current project)",
        },
      },
      additionalProperties: false,
    },
    isConcurrencySafe: () => true,
    execute: async (input: unknown) => {
      const args = input as { directory?: string };
      const targetDir = args.directory ?? state.directory;
      const drift = await checkTemplateUpdates(targetDir, DSH_SKILL_ROOTS[0]);
      if (!needsAgentHandoff(drift)) {
        return "templates current";
      }
      return composeUpdatePrompt(drift, targetDir);
    },
  });

  registerDshTool(ctx, state, {
    name: "dev_framework_runtime",
    description:
      "Show the live framework runtime snapshot for the project (hook registration, gate continuation posture, template drift). Read-only; use to inspect gate state mid-session.",
    parameters: {
      type: "object",
      properties: {
        directory: {
          type: "string",
          description: "Target project directory (defaults to current project)",
        },
      },
      additionalProperties: false,
    },
    isConcurrencySafe: () => true,
    execute: async (input: unknown) => {
      const args = input as { directory?: string };
      const targetDir = args.directory ?? state.directory;
      const snapshot = await readRuntimeStatus(targetDir);
      return renderRuntimeStatus(snapshot);
    },
  });
}
