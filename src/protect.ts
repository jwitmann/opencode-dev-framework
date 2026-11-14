/**
 * Guardrail logic: match tool calls against protected paths and dangerous
 * shell commands. Pure functions — the OpenCode hook wiring lives in
 * src/index.ts.
 */

import { basename, isAbsolute, relative } from "node:path";
import { compileGlobMatchers } from "./command-utils.js";
import type { OpenCodePermission } from "./registry.js";
import type { ResolvedConfig } from "./types.js";

export type GuardDecision = "allow" | "warn" | "deny";

export interface GuardResult {
  decision: GuardDecision;
  reason?: string;
  /** The config glob or command pattern that matched, if any. */
  matchedPattern?: string;
}

/** Tools whose args carry a target file path. */
export const FILE_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "patch"]);

/** Tools whose args carry a shell command. */
export const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "shell"]);

const PATH_ARG_KEYS = ["filePath", "path", "file"] as const;
const COMMAND_ARG_KEYS = ["command", "cmd", "script"] as const;

export interface DangerousCommand {
  pattern: RegExp;
  reason: string;
}

/** Dangerous shell commands that guardrails flag. */
export const DANGEROUS_COMMANDS: DangerousCommand[] = [
  { pattern: /\bgit\s+push\b/, reason: "git push is blocked: pushing is a deliberate user action" },
  {
    pattern: /\brm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*)\b/,
    reason: "recursive force delete (rm -rf) is blocked",
  },
  { pattern: /\bgit\s+reset\s+--hard\b/, reason: "git reset --hard is blocked: it discards work" },
  {
    pattern: /\bgit\s+clean\s+-\w*f\w*/,
    reason: "git clean -f is blocked: it deletes untracked files",
  },
  { pattern: /\bmkfs\b/, reason: "mkfs is blocked: it formats filesystems" },
  { pattern: /\bdd\s[^|]*\bof=/, reason: "dd with of= is blocked: it can overwrite devices/files" },
];

/** Extract the target file path from tool args, if present. */
export function extractFilePath(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) {
    return undefined;
  }
  for (const key of PATH_ARG_KEYS) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === "string" && value !== "") {
      return value;
    }
  }
  return undefined;
}

/** Extract the shell command from tool args, if present. */
export function extractCommand(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) {
    return undefined;
  }
  for (const key of COMMAND_ARG_KEYS) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === "string" && value !== "") {
      return value;
    }
  }
  return undefined;
}

/**
 * Extract probable file-write targets from a shell command: filenames after
 * output redirections (`>`, `>>`, with optional fd/`&` prefixes, glued or
 * spaced) and operands of `tee` in command position. Heredocs (`<<`) and
 * herestrings (`<<<`) carry input, never a target, so they are ignored.
 * Token-based and deliberately over-collecting within a command tail: that
 * is harmless because callers only act on exact artifact matches, while a
 * false negative would reopen a write path. Quote-aware.
 */
export function extractRedirectTargets(command: string): string[] {
  const targets: string[] = [];
  // Operators and separators stay visible as tokens so `tee` is only
  // honored in command position (not inside quoted prose).
  const tokens: string[] = [];
  const tokenRe = /"([^"]*)"|'([^']*)'|&&|\|\||[;|&()!<>]+|[^\s;|&<>()!]+/g;
  for (let m = tokenRe.exec(command); m !== null; m = tokenRe.exec(command)) {
    tokens.push(m[1] ?? m[2] ?? m[0]);
  }
  const isSeparator = (t: string): boolean => /^(?:&&|\|\||[;|&()!<>]+)$/.test(t);
  const isBareRedirect = (t: string): boolean => /^(?:\d*>>?\|?|&>>?\|?)$/.test(t);
  // Wrappers that pass through to the real command: `sudo tee`, `env A=B
  // tee`, `VAR=val tee`, `/usr/bin/tee`. A bare `tee` elsewhere (prose,
  // array contents) is not a command.
  const isWrapper = (t: string): boolean =>
    /^(?:sudo|command|env|nice|nohup|stdbuf|time|xargs)$/.test(t) ||
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(t);
  const cmdBase = (t: string): string => t.split("/").pop() ?? t;
  // A few shell commands take plain argv paths as write targets (no
  // redirect involved): `cp`/`mv`/`install` write their last operand,
  // `sed -i` rewrites every file operand, `ed`/`ex` edit their first.
  const ARG_WRITERS_LAST = new Set(["cp", "mv", "install"]);
  const ARG_WRITERS_FIRST = new Set(["ed", "ex"]);
  const collectOperands = (from: number): string[] => {
    const operands: string[] = [];
    for (let j = from; j < tokens.length; j++) {
      const next = tokens[j];
      if (isSeparator(next) || isBareRedirect(next)) break;
      if (!next.startsWith("-") && next !== "") operands.push(next);
    }
    return operands;
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const atCommand = i === 0 || isSeparator(tokens[i - 1]) || isBareRedirect(tokens[i - 1]);
    const base = cmdBase(token);
    if (base === "tee" && (atCommand || isWrapper(tokens[i - 1] ?? ""))) {
      // `tee` writes every non-flag operand that follows it.
      for (const next of collectOperands(i + 1)) {
        if (next === "tee") break;
        targets.push(next);
      }
      continue;
    }
    if (atCommand && (ARG_WRITERS_LAST.has(base) || ARG_WRITERS_FIRST.has(base))) {
      const operands = collectOperands(i + 1);
      const pick = ARG_WRITERS_LAST.has(base) ? operands.at(-1) : operands[0];
      if (pick !== undefined) targets.push(pick);
      continue;
    }
    if (
      atCommand &&
      base === "sed" &&
      tokens.some((t, k) => k > i && (t === "-i" || t === "--in-place" || /^-i./.test(t)))
    ) {
      // First non-flag operand is the script; the rest are files.
      let skippedScript = false;
      for (const next of collectOperands(i + 1)) {
        if (!skippedScript) {
          skippedScript = true;
          continue;
        }
        targets.push(next);
      }
      continue;
    }
    if (isBareRedirect(token)) {
      const next = tokens[i + 1];
      if (next !== undefined && next !== "" && !isSeparator(next)) targets.push(next);
      continue;
    }
    // Glued forms: `2>file`, `>file`, `&>>file`. Exclude `<<`/`<<<`.
    if (token.includes(">") && !token.includes("<")) {
      const after = token.replace(/^.*?(?:\d*>>?|&>>?)/, "").replace(/^["']|["']$/g, "");
      if (after !== "") targets.push(after);
    }
  }
  return targets;
}

/**
 * Check a file path against the protected globs. Returns the matching
 * pattern, or undefined. Patterns without a slash also match basenames at
 * any depth (so `.env*` protects `config/.env.local` too). Matchers are
 * compiled once per config via the shared `compileGlobMatchers` cache.
 */
export function matchProtectedPath(
  config: ResolvedConfig,
  filePath: string,
  directory?: string,
): string | undefined {
  let candidate = filePath;
  if (directory !== undefined && isAbsolute(filePath)) {
    candidate = relative(directory, filePath);
  }
  candidate = candidate.replace(/^\.\//, "");
  const name = basename(candidate);

  for (const { pattern, match } of compileGlobMatchers(config.protect)) {
    if (match(candidate)) {
      return pattern;
    }
    if (!pattern.includes("/") && match(name)) {
      return pattern;
    }
  }
  return undefined;
}

/** Check a shell command against the dangerous-command list. */
export function matchDangerousCommand(command: string): DangerousCommand | undefined {
  return DANGEROUS_COMMANDS.find(({ pattern }) => pattern.test(command));
}

/**
 * Check whether the host OpenCode config already denies this tool.
 *
 * OpenCode's native `permission` config is a tool-to-mode object (e.g.
 * `{ edit: "deny", bash: "deny" }`). The plugin consults it only to avoid
 * double-blocking: if OpenCode already globally denies the tool a call
 * targets, the plugin stands down and lets OpenCode enforce the denial itself.
 *
 * The mapping from this plugin's tool names to OpenCode's permission keys is:
 * - file tools (edit/write/patch) -> `edit`
 * - shell tools (bash/shell) -> `bash`
 *
 * Only a literal `"deny"` mode stands the plugin down. OpenCode's `bash` may
 * instead be an object map (per-command), whose keys are ambiguous, so we
 * conservatively keep guarding there — at worst redundant noise, never a
 * crash or a missed block. Any non-object input (array, string, undefined) is
 * ignored, falling back to the plugin's own evaluation.
 */
function hostDenies(tool: string, hostPermissions: OpenCodePermission | undefined): boolean {
  if (
    hostPermissions === undefined ||
    typeof hostPermissions !== "object" ||
    Array.isArray(hostPermissions)
  ) {
    return false;
  }
  const key = FILE_TOOLS.has(tool) ? "edit" : SHELL_TOOLS.has(tool) ? "bash" : undefined;
  if (key === undefined) {
    return false;
  }
  return hostPermissions[key] === "deny";
}

function enforce(config: ResolvedConfig, reason: string, matchedPattern: string): GuardResult {
  if (config.protect_mode === "deny") {
    return { decision: "deny", reason, matchedPattern };
  }
  return { decision: "warn", reason, matchedPattern };
}

/**
 * Evaluate a tool call against the guardrail config.
 *
 * Returns `allow` when protection is disabled (`off` profile or
 * `protect_off: true`), when the tool is not guarded, or when nothing
 * matched. Otherwise returns `deny` or `warn` per `protect_mode`.
 */
export function checkToolCall(
  config: ResolvedConfig,
  tool: string,
  args: unknown,
  directory?: string,
  hostPermissions?: OpenCodePermission,
): GuardResult {
  if (config.profile === "off" || config.protect_off) {
    return { decision: "allow" };
  }

  if (FILE_TOOLS.has(tool)) {
    const filePath = extractFilePath(args);
    if (filePath === undefined) {
      return { decision: "allow" };
    }
    // If the host permission model already denies this tool, do not duplicate
    // the block here.
    if (hostDenies(tool, hostPermissions)) {
      return { decision: "allow" };
    }
    const pattern = matchProtectedPath(config, filePath, directory);
    if (pattern !== undefined) {
      return enforce(
        config,
        `${tool} on protected path "${filePath}" is blocked (matched "${pattern}")`,
        pattern,
      );
    }
    return { decision: "allow" };
  }

  if (SHELL_TOOLS.has(tool)) {
    const command = extractCommand(args);
    if (command === undefined) {
      return { decision: "allow" };
    }
    if (hostDenies(tool, hostPermissions)) {
      return { decision: "allow" };
    }
    const dangerous = matchDangerousCommand(command);
    if (dangerous !== undefined) {
      return enforce(config, `bash command blocked: ${dangerous.reason}`, dangerous.pattern.source);
    }
  }

  return { decision: "allow" };
}

/**
 * Phase 25: adapt a native `permission.evaluate` event to the guardrail
 * verdict. Maps the observed engine shapes (spike 25.1, OpenCode v2.0.26 —
 * recorded in docs/plans/08-notes.md, never guessed):
 * - action `"edit"` (covers edit/write/patch tools) with `resources[0]` =
 *   the target file path (repo-relative).
 * - action `"shell"` (covers bash/shell tools) with `resources[0]` = the
 *   shell command string.
 *
 * Returns the guardrail verdict (`deny`/`warn`) or `null` when the mapper
 * abstains (unknown action, empty resources, protection off, or no match) —
 * `null` leaves the engine verdict untouched so the engine default wins.
 * Never returns `allow`: the mapper can only deny, warn, or abstain, so it
 * can never weaken host/engine enforcement.
 */
export function toPermissionGuard(
  config: ResolvedConfig,
  action: string,
  resources: ReadonlyArray<string>,
  directory?: string,
): GuardResult | null {
  if (config.profile === "off" || config.protect_off) {
    return null;
  }
  if (resources.length === 0) {
    return null;
  }
  if (action === "edit") {
    const result = checkToolCall(config, "edit", { filePath: resources[0] }, directory, undefined);
    return result.decision === "allow" ? null : result;
  }
  if (action === "shell") {
    const result = checkToolCall(config, "bash", { command: resources[0] }, directory, undefined);
    return result.decision === "allow" ? null : result;
  }
  return null;
}
