/**
 * Per-edit lint: resolve the linter command for a changed file and run it
 * through an injectable command runner. Pure orchestration — the OpenCode
 * hook wiring lives in src/index.ts.
 */

import { basename, dirname, extname, isAbsolute, relative } from "node:path";
import picomatch from "picomatch";
import { normalizeCommandMap, splitCommand } from "./command-utils.js";
import type { CommandResult, RunCommand } from "./host.js";
import type { ResolvedConfig } from "./types.js";

/** Fallback per-lint timeout (seconds) when the config sets none. */
export const DEFAULT_LINT_TIMEOUT_SECONDS = 60;

/** Cap on concurrent linter subprocesses; per-edit and gate lints share one limiter per session. */
export const MAX_CONCURRENT_LINTS = 4;

export interface LintLimiter {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Create a FIFO semaphore bounding concurrent linter subprocesses. Queued
 * callers wait their turn — lint output is delayed under burst load, never
 * dropped. Release is in `finally`, so a throwing linter cannot wedge the
 * limiter.
 */
export function createLintLimiter(limit: number = MAX_CONCURRENT_LINTS): LintLimiter {
  let active = 0;
  const queue: Array<() => void> = [];
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (active >= limit) {
        await new Promise<void>((resolve) => {
          queue.push(resolve);
        });
      }
      active += 1;
      try {
        return await fn();
      } finally {
        active -= 1;
        const next = queue.shift();
        if (next !== undefined) {
          next();
        }
      }
    },
  };
}

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
 *
 * Compiled picomatch matchers are cached per resolved-config object (same
 * scheme as `matchProtectedPath`): the per-edit hot path pays matching
 * only, never recompilation.
 */
const excludeMatcherCache = new WeakMap<
  ResolvedConfig,
  Array<{ pattern: string; match: (candidate: string) => boolean }>
>();

function getExcludeMatchers(
  config: ResolvedConfig,
): Array<{ pattern: string; match: (candidate: string) => boolean }> {
  const cached = excludeMatcherCache.get(config);
  if (cached !== undefined) {
    return cached;
  }
  const compiled = config.exclude.map((pattern) => ({
    pattern,
    match: picomatch(pattern, { dot: true }),
  }));
  excludeMatcherCache.set(config, compiled);
  return compiled;
}

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

  for (const { pattern, match } of getExcludeMatchers(config)) {
    if (match(candidate)) {
      return pattern;
    }
    if (!pattern.includes("/") && match(name)) {
      return pattern;
    }
  }
  return undefined;
}

/**
 * Resolve the lint command for a file: the per-extension override wins over
 * the default command. The `{file}` token is replaced with the file path and
 * `{dir}` with the file's directory (package context for tools like
 * golangci-lint, which cannot typecheck a lone file); commands with neither
 * token run as-is. Returns undefined when no lint command is configured
 * at all.
 */
export function resolveLintCommand(config: ResolvedConfig, filePath: string): string[] | undefined {
  const { default: defaultCommand, byExtension } = normalizeCommandMap(config.commands.lint);
  const template = byExtension[extname(filePath)] ?? defaultCommand;
  if (template === undefined) {
    return undefined;
  }
  const dir = dirname(filePath);
  return splitCommand(template).map((token) =>
    token.replaceAll("{file}", filePath).replaceAll("{dir}", dir),
  );
}

export function resolvePreCommitCommand(filePath: string): string[] {
  return ["pre-commit", "run", "--files", filePath];
}

/**
 * Check whether the `pre-commit` binary is available in the project.
 */
export async function detectPreCommitAvailability(
  run: RunCommand,
  directory?: string,
): Promise<boolean> {
  const result = await run(["pre-commit", "--version"], { cwd: directory, timeout: 10 });
  return result.exitCode === 0;
}

/**
 * Lint a single file. Excluded files and file types without a configured
 * linter are skipped; everything else runs through the injected runner.
 */
export async function lintFile(
  run: RunCommand,
  config: ResolvedConfig,
  filePath: string,
  options?: { cwd?: string; timeout?: number; precommitAvailable?: boolean },
): Promise<LintOutcome> {
  const excluded = matchExclude(config, filePath, options?.cwd);
  if (excluded !== undefined) {
    return { skipped: true, reason: `excluded by "${excluded}"`, filePath };
  }

  const usePreCommit = config.precommit === "auto" && options?.precommitAvailable === true;
  const command = usePreCommit
    ? resolvePreCommitCommand(filePath)
    : resolveLintCommand(config, filePath);

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
