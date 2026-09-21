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
import {
  type ChangedFileTracker,
  createChangedFileTracker,
  runGate,
  summarizeGate,
} from "./gate.js";
import { runCommand, type RunCommand } from "./host.js";
import { detectPreCommitAvailability, isLintFailure, lintFile, summarizeLint } from "./lint.js";
import { createLogger, type LogFn, type LogLevel } from "./logger.js";
import { checkToolCall } from "./protect.js";
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

type StoppingVerdict =
  | { decision: "pass" }
  | { decision: "standdown"; failedSteps: string[] }
  | { decision: "blocked"; summary: string; blockCount: number; maxBlocks: number };

async function runGateVerdict(state: HookState, _sessionID: string): Promise<StoppingVerdict> {
  if (!state.config.gate || state.config.profile === "off") {
    return { decision: "pass" };
  }
  const changedFiles = state.tracker.getChangedFiles();
  const report = await runGate(state.run, state.config, changedFiles, { cwd: state.directory });
  if (!report.ran || report.ok) {
    state.tracker.clearChangedFiles();
    state.blockCounts.delete(_sessionID);
    return { decision: "pass" };
  }
  const maxBlocks = state.config.gate.max_blocks ?? 3;
  const blockCount = (state.blockCounts.get(_sessionID) ?? 0) + 1;
  state.blockCounts.set(_sessionID, blockCount);

  if (blockCount > maxBlocks) {
    state.tracker.clearChangedFiles();
    await safeLog(
      state,
      "warn",
      `completion gate has blocked ${maxBlocks} times; standing down but checks are still failing`,
      {
        failedSteps: report.failedSteps.map((s) => s.name),
      },
    );
    return { decision: "standdown", failedSteps: report.failedSteps.map((s) => s.name) };
  }

  const summary = summarizeGate(report);
  await safeLog(state, "error", summary, { failedSteps: report.failedSteps.map((s) => s.name) });
  return { decision: "blocked", summary, blockCount, maxBlocks };
}

function stoppingMessage(verdict: Extract<StoppingVerdict, { decision: "blocked" }>): string {
  return (
    `opencode-dev-framework completion gate blocked you from finishing (block ${verdict.blockCount}/${verdict.maxBlocks}). ` +
    `The following checks failed:\n\n${verdict.summary}\n\n` +
    `Fix the underlying cause and continue. Do NOT disable, skip, or weaken these checks to make them pass.`
  );
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

    // 1) Constitution injection — per model request (V1: experimental.chat.system.transform -> V2: session.hook("context", ...))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (ctx.session as any).hook(
      "context",
      async (event: { system: Array<{ text: string }>; [k: string]: unknown }) => {
        if (!activeState) return;
        await reloadConfigIfChanged(activeState);
        if (activeState.config.profile === "off") return;
        if (!activeState.constitution) return;
        // V2 system is Array<SystemPart> {type:"text", text:string}
        const already = event.system.some((part: { text: string }) =>
          part.text.includes(activeState!.constitution!),
        );
        if (already) return;
        event.system.push({
          type: "text",
          text: activeState.constitution,
        } as (typeof event.system)[number]);
        await safeLog(activeState, "info", "constitution injected into system prompt");
      },
    );

    // Also hook other request kinds so the reminder is not missed on title/generate
    // (no-op if model doesn't need it; cheap)
    for (const kind of ["generate", "compaction"] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (ctx.session as any).hook(
        kind,
        async (event: { system?: Array<{ text: string }>; [k: string]: unknown }) => {
          if (!activeState || activeState.config.profile === "off" || !activeState.constitution)
            return;
          // generate/compaction also have system — inject similarly if present
          const ev = event as { system?: Array<{ type: string; text: string }> };
          if (!ev.system) return;
          const already = ev.system.some((p: { text: string }) =>
            p.text.includes(activeState!.constitution!),
          );
          if (!already) ev.system.push({ type: "text" as const, text: activeState.constitution });
        },
      );
    }

    // 2) Guardrails — tool execution blocking (V1: tool.execute.before -> V2: ctx.tool.hook("execute.before", ...))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (ctx.tool as any).hook(
      "execute.before",
      async (event: { tool: string; input: unknown; sessionID: string }) => {
        if (!activeState) {
          throw new Error(
            "[opencode-dev-framework] plugin state is not available; guardrail cannot evaluate this tool call",
          );
        }
        await reloadConfigIfChanged(activeState);
        if (activeState.config.profile === "off") return;
        // V2 event shapes: { tool, sessionID, agent, messageID, id, input: unknown }
        const toolName = (event as { tool: string }).tool;
        const input = (event as { input: unknown }).input;
        const sessionID = (event as { sessionID: string }).sessionID;
        // hostPermissions: not available in V2 permission model; pass undefined (conservative — still guard)
        const result = checkToolCall(
          activeState.config,
          toolName,
          input,
          activeState.directory,
          undefined,
        );
        if (result.decision === "allow") return;
        const message = result.reason ?? "blocked by guardrails";
        const extra = { tool: toolName, sessionID, pattern: result.matchedPattern };
        if (result.decision === "warn") {
          await safeLog(activeState, "warn", message, extra);
          return;
        }
        await safeLog(activeState, "error", message, extra);
        throw new Error(`[opencode-dev-framework] ${message}`);
      },
    );

    // 3) Custom tools — V2: ctx.tool.transform(editor => editor.add(...))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
          if (activeState && activeState.directory === targetDir) {
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
          const cfg =
            activeState && activeState.directory === targetDir
              ? activeState.config
              : loadConfig(targetDir);
          // renderStatus expects HookState? pass activeState
          return {
            content: renderStatus(
              cfg,
              activeState as unknown as Parameters<typeof renderStatus>[1],
            ),
          };
        },
      });
    });

    // 4) Event subscription — file tracking + gate enforcement (V1: event hook)
    // Keeps the completion gate intent without session.stopping: on idle, run gate;
    // on failure inside budget, re-prompt the session (async block).
    const controller = new AbortController();
    const eventLoop = (async () => {
      try {
        for await (const rawEvent of ctx.event.subscribe({ signal: controller.signal })) {
          const event = rawEvent as { type: string; data?: unknown; properties?: unknown } & Record<
            string,
            unknown
          >;
          const type = event.type;

          if (isSessionDeletedEvent(type)) {
            // session.deleted: cleanup blockCounts (and tracker if needed)
            const sid = getEventSessionID(event);
            if (sid && activeState) activeState.blockCounts.delete(sid);
            continue;
          }

          if (isFilesystemChangedEvent(type)) {
            if (!activeState) continue;
            await reloadConfigIfChanged(activeState);
            if (activeState.config.profile === "off") continue;
            const filePath = getEventFilePath(event);
            if (!filePath) continue;
            activeState.tracker.add(filePath, activeState.directory);

            // per-edit lint (V1: event file.edited -> lintFile)
            if (!activeState.config.on_edit.lint) continue;
            if (
              activeState.config.precommit === "auto" &&
              activeState.precommitAvailable === undefined
            ) {
              activeState.precommitAvailable = await detectPreCommitAvailability(
                activeState.run,
                activeState.directory,
              );
            }
            const outcome = await lintFile(activeState.run, activeState.config, filePath, {
              cwd: activeState.directory,
              timeout: activeState.config.gate?.timeout,
              precommitAvailable: activeState.precommitAvailable,
            });
            if (outcome.skipped) {
              await safeLog(activeState, "debug", summarizeLint(outcome), {
                filePath,
                reason: outcome.reason,
              });
              continue;
            }
            if (!isLintFailure(outcome)) {
              await safeLog(activeState, "info", summarizeLint(outcome), { filePath });
              continue;
            }
            const summary = summarizeLint(outcome);
            await safeLog(activeState, "error", summary, {
              filePath,
              command: outcome.command?.join(" "),
              stdout: outcome.result?.stdout,
              stderr: outcome.result?.stderr,
            });
            if (activeState.config.profile === "strict") {
              // Event handlers cannot throw to block the edit (edit already happened), but we log loudly.
              // In V2 we also have the tool hook to block before; this is advisory.
            }
            continue;
          }

          if (isIdleEvent(event as { type: string; data?: unknown; properties?: unknown })) {
            if (!activeState) continue;
            await reloadConfigIfChanged(activeState);
            if (activeState.config.profile === "off") continue;
            if (!activeState.config.gate) {
              await safeLog(
                activeState,
                "warn",
                "plugin config is incomplete (missing gate section), skipping completion gate",
                {
                  directory: activeState.directory,
                },
              );
              continue;
            }
            const sessionID = getEventSessionID(event);
            if (!sessionID) continue;

            const verdict = await runGateVerdict(activeState, sessionID);
            if (verdict.decision === "pass") continue;
            if (verdict.decision === "standdown") {
              // already logged in runGateVerdict; do not re-prompt
              continue;
            }
            // blocked -> re-prompt the session (V2 replacement for session.stopping output.stop=false)
            const message = stoppingMessage(verdict);
            try {
              // Prefer prompt (creates a user turn and wakes the agent); fallback to synthetic if prompt not available
              if (typeof ctx.session.prompt === "function") {
                await ctx.session.prompt({ sessionID, text: message });
              } else if (typeof ctx.session.synthetic === "function") {
                await ctx.session.synthetic({ sessionID, text: message });
              } else {
                await safeLog(
                  activeState,
                  "error",
                  `gate blocked but no session prompt API available: ${message}`,
                );
              }
              await safeLog(
                activeState,
                "info",
                `completion gate re-prompted session ${sessionID} (block ${verdict.blockCount}/${verdict.maxBlocks})`,
              );
            } catch (err) {
              await safeLog(
                activeState,
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
        await safeLog(activeState, "error", `event loop error: ${String(err)}`);
      }
    })();

    // Ensure the loop doesn't block setup
    void eventLoop;

    return () => {
      controller.abort();
      activeState = null;
    };
  },
});

export default plugin;
