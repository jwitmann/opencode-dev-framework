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

import { createBlockStore, createStuckSnapshotStore } from "../../core/block-store.js";
import { loadConfig } from "../../core/config.js";
import { renderStatus } from "../../core/format-status.js";
import { createChangedFileTracker } from "../../core/gate.js";
import {
  artifactState,
  createPassCache,
  PREFLIGHT_ARTIFACT_REL,
  preflightBlockReason,
} from "../../core/harness.js";
import {
  createLintLimiter,
  detectPreCommitAvailability,
  formatFile,
  isFormatFailure,
  isLintFailure,
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
import {
  actOnVerdict,
  getFallbackLog,
  type HookState,
  reloadConfigIfChanged,
  runCompletion,
  safeLog,
  setActiveState,
  setFallbackLog,
} from "../../core/run-hooks.js";
import type { Profile, ResolvedConfig } from "../../core/types.js";
import { snapshotEnforceable } from "../../core/weakening.js";
import { type DshExec, extractDshCommand, extractDshPaths } from "./extract.js";

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
  readonly session?: { readonly header?: { readonly id?: unknown } };
  steer?(message: DshUserMessage): void;
  followup?(message: DshUserMessage): void;
}

export type DshPreDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "cancel" }
  | { kind: "ask"; reason?: string };

export type DshPostDecision =
  | { kind: "accept"; additionalContexts?: DshUserMessage[] }
  | { kind: "block"; feedback: Array<{ type: "text"; text: string }> };

export interface DshCommands {
  register(def: {
    name: string;
    description: string;
    handler: () =>
      | { kind: "success" | "error"; text: string }
      | Promise<{ kind: "success" | "error"; text: string }>;
  }): void;
}

export interface DshToolResult {
  readonly isError: boolean;
}

/** Structural plugin context: only the seams the adapter touches. */
export interface DshContext {
  readonly subprocess: DshSubprocess;
  readonly logger: DshLogger;
  readonly commands: DshCommands;
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
    // `signal` mirrors the host payload but is not wired yet: the core gate
    // has no abort input (same as the OpenCode idle path). Follow-up, not drift.
    listener: (payload: {
      agent: DshAgent;
      turn: unknown;
      signal?: AbortSignal;
    }) => Promise<void> | void,
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
  return { kind: "deny", reason: result.reason ?? "blocked by guardrails" };
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

  // Re-entrancy guard: `formatFile` mutates, so it re-fires `post-execute`.
  // The guard lives here, never in core (plan 25 §Risks).
  const inflight = new Set<string>();

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
              return { kind: "deny", reason } satisfies DshPreDecision;
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
        return { kind: "deny", reason: message } satisfies DshPreDecision;
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

  ctx.on("agent/turn-stopping", async ({ agent, turn }) => {
    try {
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
      if (message === null) {
        return;
      }
      // Blocked: steer the turn back with the gate summary. `steer` lands at
      // the next step boundary; `followup` queues a turn when steering is
      // unavailable. Budget exhaustion is already a core `standdown` verdict
      // (no steer) — the adapter never counts blocks itself.
      const followup = dshUserMessage(message);
      try {
        if (typeof agent.steer === "function") {
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
    name: "odf-status",
    description: "Show opencode-dev-framework gate status (profile, config, enforcement level).",
    handler: () => ({ kind: "success", text: renderStatus(state.config, state) }),
  });
}
