import { join } from "node:path";
import { loadConfig } from "./config.js";
import type { GateReport } from "./gate.js";
import { inspectCompletion, type CompletionInspection } from "./harness.js";
import { createLintLimiter } from "./lint.js";
import { setProfileInFile } from "./installer.js";
import type { RunCommand } from "./host.js";
import type { Profile, ResolvedConfig } from "./types.js";

/**
 * Change the project profile by editing the config file on disk. The server
 * plugin reloads the in-memory config on the next tool call / gate run (see
 * `reloadConfigIfChanged` in index.ts), so the change does not require a
 * restart. Used by both the `/df-profile` TUI command and the
 * `dev_framework_set_profile` custom tool.
 */
export async function changeProfile(directory: string, profile: Profile): Promise<string> {
  const configPath = join(directory, ".opencode-dev-framework.yml");
  await setProfileInFile(configPath, profile);
  return `opencode-dev-framework profile set to "${profile}". Change applies on the next tool call / gate run.`;
}

/**
 * Manual verification result. `verdict` reports the raw inspection outcome:
 * PASS only when the gate passes AND review (when required) is satisfied.
 * Advisory profiles report raw FAIL here — the non-blocking behavior lives
 * in the idle policy (`evaluateCompletion`), not in this verdict.
 */
export interface VerifyResult {
  report: GateReport;
  inspection: CompletionInspection;
  verdict: "PASS" | "FAIL";
  summary: string;
}

/**
 * Run manual verification for a project: the same full completion contract
 * as the idle gate (gate commands plus review state), without any retry
 * policy. Side-effect-free by construction: this function receives only a
 * read-only changed-file snapshot and has no handle on the tracker, the
 * block store, or session input. Git discovery is included so a verify with
 * an empty tracker still sees worktree changes.
 *
 * When `config` is omitted the project config is loaded from disk.
 * `changedFiles` is normally the server's live tracker snapshot (empty for
 * TUI callers); Git-discovered files are unioned in either way.
 */
export async function verifyGate(
  run: RunCommand,
  directory: string,
  config?: ResolvedConfig,
  changedFiles: string[] = [],
): Promise<VerifyResult> {
  const cfg = config ?? loadConfig(directory);
  const inspection = await inspectCompletion({
    run,
    config: cfg,
    directory,
    trackerFiles: changedFiles,
    // Fresh limiter per manual verify (bounds its own lint burst); no pass
    // cache — an explicit verify always inspects the live tree.
    lintLimiter: createLintLimiter(),
  });
  const verdict: VerifyResult["verdict"] = inspection.ok ? "PASS" : "FAIL";
  const summary = `DEV_FRAMEWORK_VERDICT: ${verdict}\n${inspection.summary}`;
  return { report: inspection.report, inspection, verdict, summary };
}
