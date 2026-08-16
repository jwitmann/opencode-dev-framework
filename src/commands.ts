import { join } from "node:path";
import { loadConfig } from "./config.js";
import { runGate, summarizeGate, type GateReport } from "./gate.js";
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
 * Run the completion gate manually for a project. When `config` is omitted the
 * project config is loaded from disk. `changedFiles` is normally empty for a
 * manual verify (the server's live tracker is not visible from the TUI), so a
 * `scope: changed` gate will report "no changed files".
 */
export async function verifyGate(
  run: RunCommand,
  directory: string,
  config?: ResolvedConfig,
  changedFiles: string[] = [],
): Promise<{ report: GateReport; summary: string }> {
  const cfg = config ?? loadConfig(directory);
  const report = await runGate(run, cfg, changedFiles, { cwd: directory });
  return { report, summary: summarizeGate(report) };
}
