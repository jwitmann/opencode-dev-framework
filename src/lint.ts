/**
 * Per-edit lint: resolve the linter command for a changed file and run it
 * through an injectable command runner. Pure orchestration — the OpenCode
 * hook wiring lives in src/index.ts.
 */

import { basename, extname, isAbsolute, relative } from "node:path";
import picomatch from "picomatch";
import { normalizeCommandMap, splitCommand } from "./config-to-opencode.js";
import type { CommandResult, RunCommand } from "./host.js";
import type { ResolvedConfig } from "./types.js";

/** Fallback per-lint timeout (seconds) when the config sets none. */
export const DEFAULT_LINT_TIMEOUT_SECONDS = 60;

export interface LintOutcome {
  /** True when no linter ran (file excluded or no command configured). */
  skipped: boolean;
  /** Why the file was skipped, when it was. */
  reason?: string;
  filePath: string;
  /** The argv that was executed, when a linter ran. */
  command?: string[];
  result?: CommandResult;
}

/**
 * Match a file path against the config `exclude` globs. Returns the matching
 * pattern, or undefined. Patterns without a slash also match basenames at
 * any depth, mirroring protected-path semantics.
 */
export function matchExclude(
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

  for (const pattern of config.exclude) {
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

/**
 * Resolve the lint command for a file: the per-extension override wins over
 * the default command. The `{file}` token is replaced with the file path;
 * commands without the token run as-is. Returns undefined when no lint
 * command is configured at all.
 */
export function resolveLintCommand(config: ResolvedConfig, filePath: string): string[] | undefined {
  const { default: defaultCommand, byExtension } = normalizeCommandMap(config.commands.lint);
  const template = byExtension[extname(filePath)] ?? defaultCommand;
  if (template === undefined) {
    return undefined;
  }
  return splitCommand(template).map((token) => token.replaceAll("{file}", filePath));
}

/**
 * Lint a single file. Excluded files and file types without a configured
 * linter are skipped; everything else runs through the injected runner.
 */
export async function lintFile(
  run: RunCommand,
  config: ResolvedConfig,
  filePath: string,
  options?: { cwd?: string; timeout?: number },
): Promise<LintOutcome> {
  const excluded = matchExclude(config, filePath, options?.cwd);
  if (excluded !== undefined) {
    return { skipped: true, reason: `excluded by "${excluded}"`, filePath };
  }

  const command = resolveLintCommand(config, filePath);
  if (command === undefined) {
    return { skipped: true, reason: "no lint command configured for this file type", filePath };
  }

  const result = await run(command, {
    cwd: options?.cwd,
    timeout: options?.timeout ?? DEFAULT_LINT_TIMEOUT_SECONDS,
  });
  return { skipped: false, filePath, command, result };
}

/** True when a lint outcome represents a failure (non-zero exit or timeout). */
export function isLintFailure(outcome: LintOutcome): boolean {
  if (outcome.skipped || outcome.result === undefined) {
    return false;
  }
  return outcome.result.timedOut || outcome.result.exitCode !== 0;
}

/** One-line summary of a lint outcome for logging. */
export function summarizeLint(outcome: LintOutcome): string {
  if (outcome.skipped) {
    return `lint skipped for ${outcome.filePath}: ${outcome.reason ?? "unknown reason"}`;
  }
  const result = outcome.result;
  if (result === undefined) {
    return `lint produced no result for ${outcome.filePath}`;
  }
  if (result.timedOut) {
    return `lint timed out for ${outcome.filePath}`;
  }
  if (result.exitCode !== 0) {
    return `lint failed for ${outcome.filePath} (exit ${result.exitCode})`;
  }
  return `lint passed for ${outcome.filePath}`;
}
