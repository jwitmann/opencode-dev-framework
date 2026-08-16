/**
 * Completion gate: run typecheck / test / lint-changed commands when the
 * session tries to stop, plus the changed-file tracking that feeds it.
 *
 * The gate runs from two call sites:
 * - `experimental.session.stopping` (OpenCode PR #41811): on failure, a
 *   synthetic user message keeps the session running, up to `gate.max_blocks`.
 * - `session.idle` (fallback on older OpenCode): advisory logging only — by
 *   then the agent's turn has already finished, so failures cannot block.
 */

import { isAbsolute, relative } from "node:path";
import { splitCommand } from "./config-to-opencode.js";
import type { CommandResult, RunCommand } from "./host.js";
import { lintFile } from "./lint.js";
import type { ResolvedConfig } from "./types.js";

/** Fallback per-command timeout (seconds) when `gate.timeout` is unset. */
export const DEFAULT_GATE_TIMEOUT_SECONDS = 300;

/** Tracks files edited during a session so the gate can scope work. */
export interface ChangedFileTracker {
  add: (filePath: string, directory?: string) => void;
  getChangedFiles: () => string[];
  clearChangedFiles: () => void;
}

/**
 * Create a changed-file tracker. Paths are deduplicated and stored relative
 * to the project directory when one is provided.
 */
export function createChangedFileTracker(): ChangedFileTracker {
  const files = new Set<string>();
  return {
    add(filePath, directory) {
      let candidate = filePath;
      if (directory !== undefined && isAbsolute(filePath)) {
        candidate = relative(directory, filePath);
      }
      files.add(candidate.replace(/^\.\//, ""));
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
  /** `typecheck`, `test`, or `lint:<file>`. */
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
 * Run the completion gate. Steps run sequentially and all results are
 * aggregated — a failing step does not abort the remaining steps.
 */
export async function runGate(
  run: RunCommand,
  config: ResolvedConfig,
  changedFiles: string[],
  options?: { cwd?: string },
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

  if (config.gate.run_typecheck) {
    if (config.commands.typecheck !== undefined) {
      const command = splitCommand(config.commands.typecheck);
      steps.push({
        name: "typecheck",
        command,
        skipped: false,
        result: await run(command, runOptions),
      });
    } else {
      steps.push({ name: "typecheck", skipped: true, reason: "no typecheck command configured" });
    }
  }

  if (config.gate.run_tests) {
    const template =
      config.gate.scope === "changed" ? config.commands.test_changed : config.commands.test;
    if (template !== undefined) {
      const command = substituteFiles(template, changedFiles);
      steps.push({ name: "test", command, skipped: false, result: await run(command, runOptions) });
    } else {
      const reason =
        config.gate.scope === "changed"
          ? "no test_changed command configured"
          : "no test command configured";
      steps.push({ name: "test", skipped: true, reason });
    }
  }

  if (config.gate.lint_changed) {
    for (const file of changedFiles) {
      const outcome = await lintFile(run, config, file, runOptions);
      steps.push({
        name: `lint:${file}`,
        command: outcome.command,
        skipped: outcome.skipped,
        reason: outcome.reason,
        result: outcome.result,
      });
    }
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
