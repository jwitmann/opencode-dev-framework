import { normalizeCommandMap } from "./command-utils.js";
import { REVIEW_ARTIFACT_REL } from "./harness.js";
import type { ResolvedConfig } from "./types.js";

/** Stable header prefix identifying roster parts in the system prompt. */
export const ROSTER_MARKER = "## Session duties (opencode-dev-framework";

/** Max acceptance checks listed verbatim before collapsing to `+ N more`. */
export const MAX_ROSTER_ACCEPTANCE = 5;

/** Max command characters shown verbatim before truncation. */
export const MAX_ROSTER_COMMAND_LENGTH = 120;

function truncateCommand(command: string): string {
  if (command.length <= MAX_ROSTER_COMMAND_LENGTH) return command;
  return `${command.slice(0, MAX_ROSTER_COMMAND_LENGTH - 1)}…`;
}

function describeLint(config: ResolvedConfig): string | null {
  const { default: defaultLint, byExtension } = normalizeCommandMap(config.commands.lint);
  const exts = Object.keys(byExtension);
  if (defaultLint !== undefined && exts.length === 0) {
    return `\`${truncateCommand(defaultLint)}\``;
  }
  if (defaultLint !== undefined && exts.length > 0) {
    return `\`${truncateCommand(defaultLint)}\` + per-extension (${exts.sort().join(", ")})`;
  }
  if (exts.length > 0) {
    return `per-extension (${exts.sort().join(", ")})`;
  }
  return null;
}

/**
 * Render the per-project duty roster for session-start legibility.
 *
 * Pure projection of `ResolvedConfig` to a short markdown checklist:
 * which gate steps will run at idle, over what scope, whether the
 * review artifact is required, and the block budget. Returns null
 * only for `off` (no duties enforced). When nothing is configured
 * the roster says so explicitly — "nothing will stop you" is itself
 * legibility.
 */
export function renderDutyRoster(config: ResolvedConfig): string | null {
  if (config.profile === "off") return null;

  const blockingNote =
    config.profile === "advisory" ? " (advisory — failures warn, never block)" : "";
  const lines: string[] = [`${ROSTER_MARKER}, profile ${config.profile})${blockingNote}`];
  lines.push("Before you finish, this will run:");

  const steps: string[] = [];

  if (config.gate.run_typecheck && config.commands.typecheck !== undefined) {
    steps.push(`- [ ] typecheck: \`${truncateCommand(config.commands.typecheck)}\``);
  }

  if (config.gate.run_tests) {
    const template =
      config.gate.scope === "changed" ? config.commands.test_changed : config.commands.test;
    if (template !== undefined) {
      steps.push(`- [ ] test (${config.gate.scope}): \`${truncateCommand(template)}\``);
    }
  }

  if (config.gate.lint_changed) {
    const lint = describeLint(config);
    if (lint !== null) {
      steps.push(`- [ ] lint changed files: ${lint}`);
    }
  }

  const acceptance = config.gate.acceptance;
  for (const check of acceptance.slice(0, MAX_ROSTER_ACCEPTANCE)) {
    steps.push(`- [ ] acceptance:${check.name}: \`${truncateCommand(check.command)}\``);
  }
  if (acceptance.length > MAX_ROSTER_ACCEPTANCE) {
    steps.push(`- [ ] + ${acceptance.length - MAX_ROSTER_ACCEPTANCE} more acceptance checks`);
  }

  if (config.gate.require_review) {
    steps.push(`- [ ] review: write ${REVIEW_ARTIFACT_REL}`);
  }

  if (config.preflight.length > 0) {
    const taskWord = config.preflight.length === 1 ? "task" : "tasks";
    steps.push(
      `- [ ] preflight: complete ${config.preflight.length} ${taskWord} -> preflight.md before editing`,
    );
  }

  if (steps.length === 0) {
    lines.push("No checks configured — gate will skip.");
  } else {
    lines.push(...steps);
  }

  const skipNote = config.gate.skip_unchanged
    ? "Skips only when no files changed."
    : "Runs even with no changed files.";
  lines.push(`Budget: ${config.gate.max_blocks} blocks. ${skipNote}`);

  return lines.join("\n");
}

/** True when the exact roster text is already present in the system parts. */
export function rosterPresent(
  parts: ReadonlyArray<{ text: string } | string>,
  roster: string,
): boolean {
  return parts.some((part) => {
    const text = typeof part === "string" ? part : part.text;
    return text.includes(roster);
  });
}

/** Index of an existing roster part (by stable marker), or -1 when absent. */
export function findRosterIndex(parts: ReadonlyArray<{ text: string } | string>): number {
  return parts.findIndex((part) => {
    const text = typeof part === "string" ? part : part.text;
    return text.includes(ROSTER_MARKER);
  });
}
