/**
 * DSH envelope extraction (pure, host-agnostic).
 *
 * DSH tool names and arg shapes differ from OpenCode's (`file_path`
 * snake_case, `apply_patch` patch-text input, `bash`/`shell` with
 * `command`), so this module normalizes a DSH `ToolExecution` into the
 * plain strings core guards consume. Verdicts and reason text always come
 * from core (`decideFileGuard`/`decideShellGuard`) — never built here.
 */

import { extractCommand, extractFilePath } from "../../core/protect.js";

/** Host session header parentage (structural — no DSH imports).
 * Shared by `DshExec["agent"]` and the adapter's `DshAgent` so the two
 * never fork: one spelling for the header both sides read. */
export interface DshSessionHeader {
  readonly origin?: unknown;
  readonly parentSession?: unknown;
}

/** Minimal DSH tool-execution shape (structural — no DSH imports). */
export interface DshExec {
  readonly name: string;
  readonly arguments?: unknown;
  /**
   * Executing agent, when the host attaches it (carries session
   * parentage for the child-session guard; structural so no host
   * import is needed — compatible with the adapter's `DshAgent`).
   */
  readonly agent?: {
    readonly session?: {
      readonly header?: DshSessionHeader;
    };
  };
}

/**
 * File paths a DSH tool call intends to mutate.
 *
 * - `write`/`edit`: `file_path` (DSH snake_case) plus the core camelCase
 *   keys, via core `extractFilePath`.
 * - `apply_patch`: `*** Add|Update|Move to|Delete File: path` headers
 *   (DSH patch-text format, relative to the session working directory).
 *   Any other envelope yields `[]` — callers warn loudly in that case
 *   rather than silently standing down.
 * - Shell tools yield `[]` here; their write targets come from
 *   `extractRedirectTargets` on the command string (core), wired by the
 *   adapter's post-execute path union.
 */
export function extractDshPaths(exec: DshExec): string[] {
  const args = exec.arguments;
  if (
    (exec.name === "write" || exec.name === "edit") &&
    typeof args === "object" &&
    args !== null
  ) {
    const record = args as Record<string, unknown>;
    const snake = record["file_path"];
    if (typeof snake === "string" && snake !== "") {
      return [snake];
    }
    const camel = extractFilePath(args);
    if (camel !== undefined) {
      return [camel];
    }
    return [];
  }
  if (exec.name === "apply_patch" && typeof args === "object" && args !== null) {
    const input = (args as Record<string, unknown>)["input"];
    if (typeof input !== "string") {
      return [];
    }
    const paths: string[] = [];
    for (const m of input.matchAll(
      /^\*\*\* (?:Add File|Update File|Move to|Delete File): (.+)$/gm,
    )) {
      const p = m[1].trim();
      if (p !== "") {
        paths.push(p);
      }
    }
    return paths;
  }
  return [];
}

/** Shell command string for `bash`/`shell` tools, if present. */
export function extractDshCommand(exec: DshExec): string | undefined {
  if (exec.name !== "bash" && exec.name !== "shell") {
    return undefined;
  }
  return extractCommand(exec.arguments);
}
