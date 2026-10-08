/**
 * opencode-dev-framework V2 plugin entry point.
 *
 * V2 framework (opencode v2): Plugin.define({ id, setup(ctx) })
 * - ctx.session.hook("context", ...) -> constitution injection
 * - ctx.tool.hook("execute.before", ...) -> guardrails
 * - ctx.event.subscribe() -> file tracking + gate enforcement via re-prompt
 * - ctx.tool.transform(...) -> custom tools
 * - ctx.command.transform(...) -> slash commands (optional)
 *
 * Gate enforcement: no synchronous `session.stopping`. On `session.idle`
 * / `session.status:idle` we run the gate and if it fails inside budget we
 * call `ctx.session.prompt({ sessionID, text: stoppingMessage })` to wake the
 * agent — async re-injection preserving the enforcement intent (see docs/plans/08-notes).
 */

import { Plugin } from "@opencode/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { clearConfigCache, loadConfig } from "./config.js";
import { type ChangedFileTracker, createChangedFileTracker } from "./gate.js";
import {
  artifactState,
  evaluateCompletion,
  PREFLIGHT_ARTIFACT_REL,
  preflightBlockReason,
  type CompletionVerdict,
} from "./harness.js";
import { runCommand, type RunCommand } from "./host.js";
import { lintFile, detectPreCommitAvailability, isLintFailure, summarizeLint } from "./lint.js";
import { createLogger, type LogFn, type LogLevel } from "./logger.js";
import { checkToolCall, extractFilePath } from "./protect.js";
import { loadConstitution } from "./rules.js";
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
  precommitAvailable?: boolean;
  configMtime?: number;
  /**
   * Set once the `session.stopping` hook has actually been invoked by core —
   * i.e. this OpenCode build supports pre-break gate vetoes (hard stops).
   * Until then the idle re-prompt fallback is the only post-flight lever.
   */
  stopHookSupported?: boolean;
}

let activeState: HookState | null = null;
let fallbackLog: LogFn = async () => {};

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

type StoppingOutput = { stop?: boolean; message?: string };

/**
 * Turn a completion verdict into the continuation message fed back to the
 * agent when blocked. Shared by the `session.stopping` hard-stop path and
 * the `session.idle` re-prompt fallback so wording (and block counting) is
 * identical on either core support level.
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

/** Assemble the completion verdict with the state's live dependencies. */
function runCompletion(state: HookState, sessionID: string): Promise<CompletionVerdict> {
  return evaluateCompletion({
    run: state.run,
    config: state.config,
    directory: state.directory,
    sessionID,
    tracker: state.tracker,
    blockCounts: state.blockCounts,
    log: (level, message, extra) => safeLog(state, level, message, extra),
  });
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

    const state: HookState = {
      directory,
      config,
      log,
      run: runCommand,
      tracker,
      constitution,
      blockCounts: new Map(),
      configMtime,
    };
    activeState = state;

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    trackRegistration(
      await (ctx.session as any).hook(
        "context",
        async (event: { system: Array<{ text: string }>; [k: string]: unknown }) => {
          if (activeState !== state) return;
          await reloadConfigIfChanged(state);
          if (state.config.profile === "off") return;
          if (!state.constitution) return;
          // V2 system is Array<SystemPart> {type:"text", text:string}
          const already = event.system.some((part: { text: string }) =>
            part.text.includes(state.constitution!),
          );
          if (already) return;
          event.system.push({
            type: "text",
            text: state.constitution,
          } as (typeof event.system)[number]);
          await safeLog(state, "info", "constitution injected into system prompt");
        },
      ),
    );

    // Also hook other request kinds so the reminder is not missed on title/generate
    // (no-op if model doesn't need it; cheap)
    for (const kind of ["generate", "compaction"] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      trackRegistration(
        await (ctx.session as any).hook(
          kind,
          async (event: { system?: Array<{ text: string }>; [k: string]: unknown }) => {
            if (activeState !== state) return;
            if (state.config.profile === "off" || !state.constitution) return;
            // generate/compaction also have system — inject similarly if present
            const ev = event as { system?: Array<{ type: string; text: string }> };
            if (!ev.system) return;
            const already = ev.system.some((p: { text: string }) =>
              p.text.includes(state.constitution!),
            );
            if (!already) ev.system.push({ type: "text" as const, text: state.constitution });
          },
        ),
      );
    }

    // 1b) Hard-stop completion gate — `session.stopping` (OpenCode PR #44712).
    // Fires before the agent loop breaks on natural exit: a blocked verdict
    // sets stop=false + message and the loop re-enters, so gate failures
    // physically prevent completion. Registered defensively: on builds
    // without core support the hook is simply never dispatched, and the
    // session.idle fallback below provides re-prompt enforcement instead.
    // The first invocation flips `stopHookSupported` so /df-status can show
    // which enforcement level is active.
    try {
      trackRegistration(
        // biome-ignore lint/suspicious/noExplicitAny: V2 hook names are not yet typed for session.stopping
        await (ctx.session as any).hook(
          "stopping",
          // biome-ignore lint/suspicious/noExplicitAny: core may dispatch (input, output) or a single mutable event
          async (input: any, output?: StoppingOutput) => {
            if (activeState !== state) return;
            const out: StoppingOutput = output ?? input ?? {};
            const sessionID: string =
              input?.sessionID ??
              (out as { sessionID?: string }).sessionID ??
              getEventSessionID(input) ??
              "unknown";
            state.stopHookSupported = true;
            await reloadConfigIfChanged(state);
            if (state.config.profile === "off") return;
            const verdict = await runCompletion(state, sessionID);
            const message = await actOnVerdict(state, verdict);
            if (message !== null) {
              out.stop = false;
              out.message = message;
            }
          },
        ),
      );
      await safeLog(
        state,
        "info",
        "registered session.stopping hook; if this OpenCode build dispatches it, gate failures become hard stops before loop exit",
      );
    } catch {
      await safeLog(
        state,
        "warn",
        "could not register session.stopping hook; using session.idle re-prompt fallback only",
      );
    }

    // 2) Guardrails — tool execution blocking (V1: tool.execute.before -> V2: ctx.tool.hook("execute.before", ...))
    // Stale-hook fail-open: the closure captures its own `state` and allows
    // the call whenever it is no longer live — torn down (activeState null)
    // or superseded by a newer setup (activeState is a different instance,
    // whose own hook enforces; this one must not double-enforce). Using the
    // captured `state` throughout also closes the teardown race where the
    // global is cleared between awaits. See issue #1.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    trackRegistration(
      await (ctx.tool as any).hook(
        "execute.before",
        async (event: { tool: string; input: unknown; sessionID: string }) => {
          if (activeState !== state) {
            if (activeState == null) {
              await safeLog(
                null,
                "warn",
                "[opencode-dev-framework] plugin state is not available; allowing tool call (fail-open after teardown)",
                { tool: (event as { tool?: string }).tool },
              );
            }
            return;
          }
          await reloadConfigIfChanged(state);
          if (state.config.profile === "off") return;
          // V2 event shapes: { tool, sessionID, agent, messageID, id, input: unknown }
          const toolName = (event as { tool: string }).tool;
          const input = (event as { input: unknown }).input;
          const sessionID = (event as { sessionID: string }).sessionID;

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
          const result = checkToolCall(
            state.config,
            toolName,
            input,
            state.directory,
            undefined,
          );
          if (result.decision === "allow") return;
          const message = result.reason ?? "blocked by guardrails";
          const extra = { tool: toolName, sessionID, pattern: result.matchedPattern };
          if (result.decision === "warn") {
            await safeLog(state, "warn", message, extra);
            return;
          }
          await safeLog(state, "error", message, extra);
          throw new Error(`[opencode-dev-framework] ${message}`);
        },
      ),
    );

    // 3) Custom tools — V2: ctx.tool.transform(editor => editor.add(...))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    trackRegistration(
      await (ctx.tool as any).transform((editor: { add: (t: unknown) => void }) => {
        (
          editor as {
            add: (t: {
              name: string;
              description: string;
              input: unknown;
              execute: (input: unknown) => Promise<unknown>;
            }) => void;
          }
        ).add({
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

        (editor as { add: (t: unknown) => void }).add({
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

        (editor as { add: (t: unknown) => void }).add({
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

    // 4) Event subscription — file tracking + gate enforcement (V1: event hook)
    // Keeps the completion gate intent without session.stopping: on idle, run gate;
    // on failure inside budget, re-prompt the session (async block).
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
            // session.deleted: cleanup blockCounts (and tracker if needed)
            const sid = getEventSessionID(event);
            if (sid) state.blockCounts.delete(sid);
            continue;
          }

          if (isFilesystemChangedEvent(type)) {
            if (activeState !== state) return;
            await reloadConfigIfChanged(state);
            if (state.config.profile === "off") continue;
            const filePath = getEventFilePath(event);
            if (!filePath) continue;
            state.tracker.add(filePath, state.directory);

            // per-edit lint (V1: event file.edited -> lintFile)
            if (!state.config.on_edit.lint) continue;
            if (
              state.config.precommit === "auto" &&
              state.precommitAvailable === undefined
            ) {
              state.precommitAvailable = await detectPreCommitAvailability(
                state.run,
                state.directory,
              );
            }
            const outcome = await lintFile(state.run, state.config, filePath, {
              cwd: state.directory,
              timeout: state.config.gate?.timeout,
              precommitAvailable: state.precommitAvailable,
            });
            if (outcome.skipped) {
              await safeLog(state, "debug", summarizeLint(outcome), {
                filePath,
                reason: outcome.reason,
              });
              continue;
            }
            if (!isLintFailure(outcome)) {
              await safeLog(state, "info", summarizeLint(outcome), { filePath });
              continue;
            }
            const summary = summarizeLint(outcome);
            await safeLog(state, "error", summary, {
              filePath,
              command: outcome.command?.join(" "),
              stdout: outcome.result?.stdout,
              stderr: outcome.result?.stderr,
            });
            if (state.config.profile === "strict") {
              // Event handlers cannot throw to block the edit (edit already happened), but we log loudly.
              // In V2 we also have the tool hook to block before; this is advisory.
            }
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

            const verdict = await runCompletion(state, sessionID);
            const message = await actOnVerdict(state, verdict);
            if (message === null) continue;
            const blockInfo =
              verdict.decision === "blocked"
                ? ` (block ${verdict.blockCount}/${verdict.maxBlocks})`
                : "";
            // blocked -> re-prompt the session (fallback when session.stopping
            // is not dispatched by this OpenCode build)
            try {
              // Prefer prompt (creates a user turn and wakes the agent); fallback to synthetic if prompt not available
              if (typeof ctx.session.prompt === "function") {
                await ctx.session.prompt({ sessionID, text: message });
              } else if (typeof ctx.session.synthetic === "function") {
                await ctx.session.synthetic({ sessionID, text: message });
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
