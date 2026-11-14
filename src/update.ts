/**
 * Shared per-project template-update flow: the `/df-update` server command
 * brings a deployment's shipped files current with per-file approval.
 *
 * Detection runs in code (`statusTemplates` — the same comparison `df init`
 * uses); diffing, presenting, and applying stay with the agent, which hands
 * each drifted file to the user before touching it. There is no auto-apply
 * path by construction. The user config (`.opencode-dev-framework.yml`) is
 * structurally out of scope: it was never in the template set.
 */

import { statusTemplates } from "./installer.js";
import type { TemplateStatus } from "./installer.js";

export interface TemplateDrift {
  /** Shipped files present and identical. */
  current: string[];
  /** Shipped files present with different content — offer refresh. */
  refresh: string[];
  /** Shipped files absent — offer add (reads as botched/partial install). */
  add: string[];
  /** True when nothing is installed at all — redirect to `/df-init`. */
  empty: boolean;
}

export async function checkTemplateUpdates(directory: string): Promise<TemplateDrift> {
  const status: TemplateStatus = await statusTemplates(directory);
  return {
    current: status.present,
    refresh: status.different,
    add: status.missing,
    empty: status.present.length === 0 && status.different.length === 0,
  };
}

/**
 * Compose the prompt text the `/df-update` command submits back to the
 * session. An installed-but-current tree reports status; an empty tree
 * redirects to `/df-init`; a drifted tree hands the agent the lists plus
 * standing instructions (present per file, apply only what is approved).
 */
export function composeUpdatePrompt(drift: TemplateDrift, directory: string): string {
  const total = drift.current.length + drift.refresh.length + drift.add.length;
  if (drift.empty) {
    return [
      `No opencode-dev-framework templates are installed in ${directory}.`,
      "Run /df-init for the full first-time setup instead of adding files piecemeal.",
    ].join("\n");
  }
  if (drift.refresh.length === 0 && drift.add.length === 0) {
    return [
      `opencode-dev-framework templates in ${directory} are current: ` +
        `${drift.current.length}/${total} shipped files match.`,
      "Nothing to do.",
    ].join("\n");
  }
  const lines = [
    `opencode-dev-framework template drift in ${directory}: ` +
      `${drift.current.length}/${total} current, ` +
      `${drift.refresh.length} to refresh, ${drift.add.length} to add.`,
  ];
  if (drift.refresh.length > 0) {
    lines.push("", "Refresh (differs from shipped):", ...drift.refresh.map((f) => `- ${f}`));
  }
  if (drift.add.length > 0) {
    lines.push(
      "",
      "Add (shipped, absent — likely a partial install):",
      ...drift.add.map((f) => `- ${f}`),
    );
  }
  lines.push(
    "",
    "Bring the deployment current from the lists above. For each refresh file, " +
      "run diff yourself against the shipped template, present the per-file diff, " +
      "and overwrite only what the user approves. For each add file, present what it " +
      "is and add only what the user approves. Never touch " +
      ".opencode-dev-framework.yml — it is user config, not a shipped template. " +
      "Report what was applied and what was left alone.",
  );
  return lines.join("\n");
}

/**
 * Whether the drift needs an agent handoff (a turn). Drifted trees do
 * (the agent must diff, present per file, and get approval), and empty
 * trees do too (the `/df-init` redirect guides someone who just invoked
 * the command while exploring — silence would leave zero feedback that
 * anything ran). Current trees ("nothing to do") stay silent: an empty
 * tree's missing files already read as `add`, so the two length checks
 * below cover all three cases with no special-casing.
 */
export function needsAgentHandoff(drift: TemplateDrift): boolean {
  return drift.refresh.length > 0 || drift.add.length > 0;
}

/**
 * One-line startup mention for template drift, or null when there is
 * nothing to say. Installed-but-current and empty trees stay silent: the
 * mention covers drift only (an empty tree is `/df-init` territory, and
 * the command itself already redirects there — no new nag is invented).
 */
export function driftMentionLine(drift: TemplateDrift): string | null {
  if (drift.empty || (drift.refresh.length === 0 && drift.add.length === 0)) {
    return null;
  }
  const parts: string[] = [];
  if (drift.refresh.length > 0) {
    parts.push(`${drift.refresh.length} to refresh`);
  }
  if (drift.add.length > 0) {
    parts.push(`${drift.add.length} to add`);
  }
  return (
    `opencode-dev-framework templates have drifted (${parts.join(", ")}). ` +
    "Run /df-update to review each file with approval."
  );
}

export interface UpdateCommandDeps {
  directory: string;
  delivery: unknown;
  /** Throws when the owning setup/state went stale mid-check. */
  checkAlive: () => void;
  /** Deliver the report to the session; throws on transport failure. */
  deliver: (text: string, delivery: unknown) => Promise<void>;
}

/**
 * Execute the `/df-update` command with injected dependencies (pure policy,
 * testable without a plugin context). Check, re-check liveness across the
 * await, then deliver — but only when the drift needs an agent handoff.
 * A current tree returns `false` without delivering: the server command
 * API returns void, so any delivery costs a full agent turn, and a
 * "nothing to do" turn is pure waste. A delivery failure throws: the check
 * succeeded, only the handoff back failed, and the message says how to
 * recover. Returns whether the handoff was delivered.
 */
export async function runUpdateCommand(deps: UpdateCommandDeps): Promise<boolean> {
  const drift = await checkTemplateUpdates(deps.directory);
  deps.checkAlive();
  if (!needsAgentHandoff(drift)) {
    return false;
  }
  const text = composeUpdatePrompt(drift, deps.directory);
  try {
    await deps.deliver(text, deps.delivery);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `df-update detected drift (${drift.refresh.length} to refresh, ${drift.add.length} to add) ` +
        `but the handoff back to the session failed (${detail}); retry /df-update — it only reads, never writes.`,
    );
  }
  return true;
}
