/**
 * Guardrail logic: match tool calls against protected paths and dangerous
 * shell commands. Pure functions — the OpenCode hook wiring lives in
 * src/index.ts.
 */

import { basename, isAbsolute, relative } from "node:path";
import picomatch from "picomatch";
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
 * Check a file path against the protected globs. Returns the matching
 * pattern, or undefined. Patterns without a slash also match basenames at
 * any depth (so `.env*` protects `config/.env.local` too).
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

  for (const pattern of config.protect) {
    const isMatch = picomatch(pattern, { dot: true });
    if (isMatch(candidate)) {
      return pattern;
    }
    if (!pattern.includes("/") && isMatch(name)) {
      return pattern;
    }
  }
  return undefined;
}

/** Check a shell command against the dangerous-command list. */
export function matchDangerousCommand(command: string): DangerousCommand | undefined {
  return DANGEROUS_COMMANDS.find(({ pattern }) => pattern.test(command));
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
): GuardResult {
  if (config.profile === "off" || config.protect_off) {
    return { decision: "allow" };
  }

  if (FILE_TOOLS.has(tool)) {
    const filePath = extractFilePath(args);
    if (filePath === undefined) {
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
    const dangerous = matchDangerousCommand(command);
    if (dangerous !== undefined) {
      return enforce(config, `bash command blocked: ${dangerous.reason}`, dangerous.pattern.source);
    }
  }

  return { decision: "allow" };
}
