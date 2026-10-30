/**
 * Completion gate: run typecheck / test / lint-changed commands when the
 * session goes idle, plus the changed-file tracking that feeds it.
 *
 * The gate runs from two call sites:
 * - `experimental.idle` hook: same-execution synthetic continuation on
 *   failure, up to `gate.max_blocks`.
 * - `session.idle` event net: re-prompt fallback for the boundaries the
 *   hook skips.
 */

import { isAbsolute, relative } from "node:path";
import { splitCommand } from "./command-utils.js";
import type { CommandResult, RunCommand } from "./host.js";
import { lintFile, MAX_CONCURRENT_LINTS, type LintLimiter } from "./lint.js";
import type { ResolvedConfig } from "./types.js";

/** Fallback per-command timeout (seconds) when `gate.timeout` is unset. */
export const DEFAULT_GATE_TIMEOUT_SECONDS = 300;

/** Tracks files edited during a session so the gate can scope work. */
export interface ChangedFileTracker {
  add: (filePath: string, directory?: string) => void;
  /** True when the (normalized) path is already tracked. */
  has: (filePath: string, directory?: string) => boolean;
  getChangedFiles: () => string[];
  clearChangedFiles: () => void;
}

function normalizeTrackedPath(filePath: string, directory?: string): string {
  let candidate = filePath;
  if (directory !== undefined && isAbsolute(filePath)) {
    candidate = relative(directory, filePath);
  }
  return candidate.replace(/^\.\//, "");
}

/**
 * Create a changed-file tracker. Paths are deduplicated and stored relative
 * to the project directory when one is provided.
 */
export function createChangedFileTracker(): ChangedFileTracker {
  const files = new Set<string>();
  return {
    add(filePath, directory) {
      files.add(normalizeTrackedPath(filePath, directory));
    },
    has(filePath, directory) {
      return files.has(normalizeTrackedPath(filePath, directory));
    },
    getChangedFiles() {
      return [...files];
    },
    clearChangedFiles() {
      files.clear();
    },
  };
}

export interface GateStep {
  /** `typecheck`, `test`, `lint:<file>`, or `acceptance:<name>`. */
  name: string;
  command?: string[];
  skipped: boolean;
  reason?: string;
  result?: CommandResult;
}

export interface GateReport {
  /** False when the gate did not run (unchanged project, nothing configured). */
  ran: boolean;
  reason?: string;
  steps: GateStep[];
  /** True when every executed step passed (vacuously true when nothing ran). */
  ok: boolean;
  failedSteps: GateStep[];
}

function isFailure(result: CommandResult): boolean {
  return result.timedOut || result.exitCode !== 0;
}

/**
 * Substitute the `{files}` token with the changed-file list. A token that is
 * exactly `{files}` expands to multiple argv entries (the commands run
 * without a shell); an embedded token is replaced inline.
 */
export function substituteFiles(template: string, files: string[]): string[] {
  return splitCommand(template).flatMap((token) =>
    token === "{files}" ? files : [token.replaceAll("{files}", files.join(" "))],
  );
}

/**
 * Map items through an async function with at most `limit` in flight.
 * Output order matches input order regardless of completion order.
 */
async function mapBounded<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Options for `runGate`. */
export interface GateOptions {
  /** Project directory to run commands in. */
  cwd?: string;
  /** Shared limiter bounding concurrent linter subprocesses; lints run direct when absent. */
  lintLimiter?: LintLimiter;
}

/**
 * Run the completion gate. Independent steps (typecheck, test) run
 * concurrently while the reported step order stays stable (typecheck, test,
 * lint per file, acceptance in declaration order). All results are
 * aggregated — a failing step does not abort the remaining steps.
 */
export async function runGate(
  run: RunCommand,
  config: ResolvedConfig,
  changedFiles: string[],
  options?: GateOptions,
): Promise<GateReport> {
  if (!config.gate) {
    return {
      ran: false,
      reason: "incomplete plugin config: gate section missing",
      ok: true,
      steps: [],
      failedSteps: [],
    };
  }
  if (config.gate.skip_unchanged && changedFiles.length === 0) {
    return { ran: false, reason: "no changed files", steps: [], ok: true, failedSteps: [] };
  }

  const timeout = config.gate.timeout ?? DEFAULT_GATE_TIMEOUT_SECONDS;
  const runOptions = { cwd: options?.cwd, timeout };

  const steps: GateStep[] = [];

  // Typecheck and test are independent — run them concurrently and report in
  // stable order. Skipped steps assign synchronously and never enter the
  // promise flow.
  let typecheckStep: GateStep | null = null;
  let testStep: GateStep | null = null;
  const independent: Array<Promise<void>> = [];

  if (config.gate.run_typecheck) {
    if (config.commands.typecheck !== undefined) {
      const command = splitCommand(config.commands.typecheck);
      independent.push(
        run(command, runOptions).then((result) => {
          typecheckStep = { name: "typecheck", command, skipped: false, result };
        }),
      );
    } else {
      typecheckStep = {
        name: "typecheck",
        skipped: true,
        reason: "no typecheck command configured",
      };
    }
  }

  if (config.gate.run_tests) {
    const template =
      config.gate.scope === "changed" ? config.commands.test_changed : config.commands.test;
    if (template !== undefined) {
      const command = substituteFiles(template, changedFiles);
      independent.push(
        run(command, runOptions).then((result) => {
          testStep = { name: "test", command, skipped: false, result };
        }),
      );
    } else {
      const reason =
        config.gate.scope === "changed"
          ? "no test_changed command configured"
          : "no test command configured";
      testStep = { name: "test", skipped: true, reason };
    }
  }

  await Promise.all(independent);
  if (typecheckStep !== null) {
    steps.push(typecheckStep);
  }
  if (testStep !== null) {
    steps.push(testStep);
  }

  if (config.gate.lint_changed) {
    // Per-file lints are independent — bound concurrency instead of running
    // them one at a time. When the session limiter is provided it also
    // applies, so gate bursts share headroom with per-edit lints.
    const limiter = options?.lintLimiter;
    const runOne = (file: string) =>
      limiter !== undefined
        ? limiter.run(() => lintFile(run, config, file, runOptions))
        : lintFile(run, config, file, runOptions);
    const outcomes = await mapBounded(changedFiles, MAX_CONCURRENT_LINTS, runOne);
    for (const [index, outcome] of outcomes.entries()) {
      steps.push({
        name: `lint:${changedFiles[index]}`,
        command: outcome.command,
        skipped: outcome.skipped,
        reason: outcome.reason,
        result: outcome.result,
      });
    }
  }

  // Named acceptance checks run last, sequentially, in declaration order.
  // Like every other step, a failure is aggregated — it does not abort the
  // remaining steps. `{files}` substitution and the project `cwd` match the
  // test-command semantics; per-check timeout overrides the gate default.
  for (const check of config.gate.acceptance) {
    const command = substituteFiles(check.command, changedFiles);
    steps.push({
      name: `acceptance:${check.name}`,
      command,
      skipped: false,
      result: await run(command, { cwd: options?.cwd, timeout: check.timeout ?? timeout }),
    });
  }

  const ran = steps.some((step) => !step.skipped);
  const failedSteps = steps.filter(
    (step) => !step.skipped && step.result !== undefined && isFailure(step.result),
  );
  return {
    ran,
    reason: ran ? undefined : "no gate commands configured",
    steps,
    ok: failedSteps.length === 0,
    failedSteps,
  };
}

/** One-line-per-step summary of a gate report for logging. */
export function summarizeGate(report: GateReport): string {
  if (!report.ran) {
    return `completion gate skipped: ${report.reason ?? "unknown reason"}`;
  }
  const lines = report.steps.map((step) => {
    if (step.skipped) {
      return `${step.name}: skipped (${step.reason ?? "unknown reason"})`;
    }
    const result = step.result;
    if (result === undefined) {
      return `${step.name}: no result`;
    }
    if (result.timedOut) {
      return `${step.name}: timed out`;
    }
    return result.exitCode === 0
      ? `${step.name}: passed`
      : `${step.name}: failed (exit ${result.exitCode})`;
  });
  const verdict = report.ok ? "passed" : "FAILED";
  return `completion gate ${verdict}\n${lines.join("\n")}`;
}
