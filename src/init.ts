/**
 * Shared per-project setup flow: the `/df-init` server command and the
 * `dev_framework_init` custom tool are two callers of one implementation.
 * The deterministic half (scaffold templates, detected config, trial-run,
 * brief) runs in code; the judgment half (resolve the brief, draft config
 * + hardening, present the diff) rides back to the agent as prompt text.
 *
 * Note: `bin/df` intentionally keeps its own orchestration of the same
 * installer primitives — the CLI prompts interactively on conflicts
 * (TTY), while everything here is non-interactive by construction.
 */

import { detectProject } from "./detect.js";
import type { RunCommand } from "./host.js";
import {
  buildWizardBrief,
  formatBriefSkipped,
  formatTrialRun,
  formatWizardBrief,
  installTemplates,
  trialRunDetectedCommands,
  writeDetectedConfig,
} from "./installer.js";

export interface InitScaffoldOptions {
  wizard?: boolean;
  /** Rewrite files that differ from the templates (default: skip them). */
  overwrite?: boolean;
}

export interface InitScaffold {
  created: string[];
  overwritten: string[];
  skipped: string[];
  configAction: string;
  /** Trial-run lines (non-wizard) or wizard-brief lines, for the report. */
  detailLines: string[];
  /** True when this run changed anything (templates or config). */
  fresh: boolean;
}

/**
 * Whether the scaffold result needs an agent handoff (a turn). Fresh
 * scaffolds do (the agent must resolve the brief); re-runs with warnings
 * do (reload/trial failures the user came to fix must be relayed). A clean
 * re-run stays silent: the server command API returns void, so any
 * delivery costs a full agent turn, and an "already configured" turn is
 * pure waste.
 */
export function initNeedsHandoff(scaffold: InitScaffold, warnings: string[] = []): boolean {
  return scaffold.fresh || warnings.length > 0;
}

export async function runInitScaffold(
  directory: string,
  run: RunCommand,
  options: InitScaffoldOptions = {},
): Promise<InitScaffold> {
  const overwrite = options.overwrite ?? false;
  const io = { overwriteExisting: overwrite, skipExisting: !overwrite };
  const result = await installTemplates(directory, io);
  const configResult = await writeDetectedConfig(directory, io);
  const fresh =
    result.created.length > 0 ||
    result.overwritten.length > 0 ||
    configResult.action === "created" ||
    configResult.action === "overwritten";
  // Detail work runs only when something changed: rebuilding the wizard
  // brief (detection + real command executions) on a no-op re-run would
  // burn minutes to restate what the report already says. Non-wizard
  // keeps its exact historical trigger (config created/overwritten).
  const detailLines: string[] = [];
  const wantDetail =
    options.wizard === true
      ? fresh
      : configResult.action === "created" || configResult.action === "overwritten";
  if (wantDetail) {
    if (options.wizard === true) {
      try {
        const brief = await buildWizardBrief(directory, run);
        detailLines.push("", ...formatWizardBrief(brief));
      } catch (error) {
        detailLines.push("", formatBriefSkipped(error));
      }
    } else {
      try {
        const { commands } = detectProject(directory);
        const trial = await trialRunDetectedCommands(directory, commands, run);
        detailLines.push("", ...formatTrialRun(trial));
      } catch (error) {
        detailLines.push(
          "",
          `Trial-run: skipped (${error instanceof Error ? error.message : String(error)}) — verify commands manually`,
        );
      }
    }
  }
  return {
    created: result.created,
    overwritten: result.overwritten,
    skipped: result.skipped,
    configAction: configResult.action,
    detailLines,
    fresh,
  };
}

export function scaffoldReportLines(scaffold: InitScaffold, directory: string): string[] {
  return [
    `Installed opencode-dev-framework templates into ${directory}.`,
    `Created: ${scaffold.created.length} file(s)`,
    `Overwritten: ${scaffold.overwritten.length} file(s)`,
    `Skipped: ${scaffold.skipped.length} file(s)`,
    `Config: ${scaffold.configAction}`,
    ...(scaffold.created.length > 0
      ? ["", "Created files:", ...scaffold.created.map((f) => `- ${f}`)]
      : []),
    ...(scaffold.overwritten.length > 0
      ? ["", "Overwritten files:", ...scaffold.overwritten.map((f) => `- ${f}`)]
      : []),
    ...scaffold.detailLines,
    ...(!scaffold.fresh
      ? ["", "Already configured: nothing changed, so no brief was rebuilt."]
      : []),
  ];
}

/**
 * Compose the prompt text the `/df-init` command submits back to the
 * session. A fresh scaffold hands the agent the brief plus standing
 * instructions; a re-run on an already-configured project reports
 * status. Skipped files may be identical OR differing-but-preserved —
 * the counts cannot tell them apart, so the status says so instead of
 * claiming everything is current.
 */
export function composeInitPrompt(
  scaffold: InitScaffold,
  directory: string,
  warnings: string[] = [],
): string {
  const warningLines = warnings.length > 0 ? [...warnings.map((w) => `Warning: ${w}`), ""] : [];
  if (!scaffold.fresh) {
    return [
      `opencode-dev-framework is already set up in ${directory}: ` +
        `config ${scaffold.configAction}, ${scaffold.skipped.length} template file(s) left untouched.`,
      "Untouched means identical or differing-but-preserved — differing files were NOT refreshed.",
      ...warningLines,
      "Verify with /df-status and a small probe edit; change nothing unless the user asks.",
    ].join("\n");
  }
  return [
    ...scaffoldReportLines(scaffold, directory),
    ...warningLines,
    "",
    "Set up opencode-dev-framework for this project from the report and brief above. " +
      "Follow the project-config skill to resolve the open questions — ask at most 3 genuinely " +
      "user-only questions, resolve the rest yourself by reading the repo and running the commands — " +
      "then present .opencode-dev-framework.yml + hardening.md for review. Do not commit unreviewed.",
  ].join("\n");
}

export interface InitCommandDeps {
  directory: string;
  run: RunCommand;
  delivery: unknown;
  /** Throws when the owning setup/state went stale mid-scaffold. */
  checkAlive: () => void;
  /** Reload the project config after scaffolding; throws on invalid config. */
  reload: () => Promise<void>;
  /** Deliver the handoff to the session; throws on transport failure. */
  deliver: (text: string, delivery: unknown) => Promise<void>;
  /** Side-channel observe (warn on reload failure). Never throws. */
  note: (level: "warn", message: string, extra?: Record<string, unknown>) => Promise<void>;
}

/**
 * Execute the `/df-init` command with injected dependencies (pure policy,
 * testable without a plugin context). Scaffold first, re-check liveness
 * across the long await (file IO + trial-runs), reload the just-written
 * config, then deliver the handoff — but only when it needs an agent
 * handoff (fresh scaffold, or warnings). A clean re-run returns `false`
 * without delivering: the server command API returns void, so any
 * delivery costs a full agent turn. A reload failure degrades to a
 * warning inside the prompt — `/df-init` is the command you run to fix
 * a broken setup, so it must not fail on exactly the broken setups.
 * A delivery failure throws: the scaffold succeeded, only the handoff
 * back failed, and the message says how to recover. Returns whether the
 * handoff was delivered.
 */
export async function runInitCommand(deps: InitCommandDeps): Promise<boolean> {
  const scaffold = await runInitScaffold(deps.directory, deps.run, { wizard: true });
  deps.checkAlive();
  const warnings: string[] = [];
  try {
    await deps.reload();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    warnings.push(
      `the new config could not be reloaded (${detail}) — the session keeps its previous contract; restart or fix the config and re-run.`,
    );
    await deps.note("warn", "df-init scaffolded but the config could not be reloaded", {
      directory: deps.directory,
      error: detail,
    });
  }
  if (!initNeedsHandoff(scaffold, warnings)) {
    return false;
  }
  const text = composeInitPrompt(scaffold, deps.directory, warnings);
  try {
    await deps.deliver(text, deps.delivery);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `df-init scaffolded ${scaffold.created.length} file(s) (config ${scaffold.configAction}) ` +
        `but the handoff back to the session failed (${detail}); retry /df-init — a re-run reports status without touching anything.`,
    );
  }
  return true;
}
