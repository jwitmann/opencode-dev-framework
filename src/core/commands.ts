import { join } from "node:path";
import { z } from "zod";
import { splitCommand } from "./command-utils.js";
import { existingConfigPath, loadConfig } from "./config.js";
import type { GateReport } from "./gate.js";
import { type CompletionInspection, inspectCompletion } from "./harness.js";
import type { RunCommand } from "./host.js";
import { setProfileInFile, storeGateIgnores } from "./installer.js";
import { createLintLimiter } from "./lint.js";
import type { Profile, ResolvedConfig } from "./types.js";

/**
 * Change the project profile by editing the config file on disk. The server
 * plugin reloads the in-memory config on the next tool call / gate run (see
 * `reloadConfigIfChanged` in index.ts), so the change does not require a
 * restart. Used by both the `/df-profile` TUI command and the
 * `dev_framework_set_profile` custom tool.
 */
export async function changeProfile(directory: string, profile: Profile): Promise<string> {
  // New file only when no config exists under any supported name; an
  // established deployment is edited in place, never shadowed.
  const configPath = existingConfigPath(directory) ?? join(directory, ".dev-framework.yml");
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
  sessionIgnores: readonly string[] = [],
): Promise<VerifyResult> {
  const cfg = config ?? loadConfig(directory);
  const inspection = await inspectCompletion({
    run,
    config: cfg,
    directory,
    trackerFiles: changedFiles,
    sessionIgnores,
    // Fresh limiter per manual verify (bounds its own lint burst); no pass
    // cache — an explicit verify always inspects the live tree.
    lintLimiter: createLintLimiter(),
  });
  const verdict: VerifyResult["verdict"] = inspection.ok ? "PASS" : "FAIL";
  const summary = `DEV_FRAMEWORK_VERDICT: ${verdict}\n${inspection.summary}`;
  return { report: inspection.report, inspection, verdict, summary };
}

/** Parsed `/df-ignore` arguments. `patterns` add to the session hotlist,
 * `remove` drops from it, `store` persists, `list` reports. Bare
 * invocation (everything empty) lists. */
export interface DfIgnoreArgs {
  patterns: string[];
  store: boolean;
  list: boolean;
  remove: string[];
}

const ignoreToolInputSchema = z
  .object({
    patterns: z.array(z.string()).default([]),
    store: z.boolean().default(false),
    list: z.boolean().default(false),
    remove: z.array(z.string()).default([]),
    directory: z.string().optional(),
  })
  .strict();

export type DfIgnoreToolInput = z.infer<typeof ignoreToolInputSchema>;

/**
 * Validate a direct `dev_framework_ignore` tool call. The hosts normally
 * enforce the advertised JSON Schema, but the execute seam accepts unknown
 * input and tests or other integrations can call it directly. Return a
 * readable error instead of letting a type assertion turn bad input into an
 * uncaught TypeError. Defaults are normalized here for both adapters.
 */
export function parseIgnoreToolInput(
  input: unknown,
): { ok: true; args: DfIgnoreToolInput } | { ok: false; error: string } {
  const result = ignoreToolInputSchema.safeParse(input);
  if (result.success) return { ok: true, args: result.data };
  const issues = result.error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
  return { ok: false, error: `Invalid dev_framework_ignore input:\n${issues}` };
}

/**
 * Parse `/df-ignore` raw input (the DSH slash form). Flags anywhere:
 * `-s|--store`, `-l|--list`, `-r|--remove` (following non-flag tokens are
 * removals), `--` ends flag parsing. Quote-aware via `splitCommand`, so
 * patterns with spaces quote (`"my dir/**"`). Throws a readable error on
 * unknown flags instead of silently ignoring them.
 */
export function parseIgnoreArgs(rawInput: string): DfIgnoreArgs {
  const args: DfIgnoreArgs = { patterns: [], store: false, list: false, remove: [] };
  let toRemove = false;
  let flagsOpen = true;
  for (const token of splitCommand(rawInput)) {
    if (flagsOpen && !toRemove && (token === "-s" || token === "--store")) {
      args.store = true;
      continue;
    }
    if (flagsOpen && !toRemove && (token === "-l" || token === "--list")) {
      args.list = true;
      continue;
    }
    if (flagsOpen && (token === "-r" || token === "--remove")) {
      toRemove = true;
      continue;
    }
    if (flagsOpen && token === "--") {
      flagsOpen = false;
      continue;
    }
    if (flagsOpen && !toRemove && token.startsWith("-") && token !== "-") {
      throw new Error(
        `Unknown /df-ignore flag "${token}". Flags: -s|--store, -l|--list, -r|--remove, -- to end flag parsing.`,
      );
    }
    (toRemove ? args.remove : args.patterns).push(token);
  }
  return args;
}

export interface DfIgnoreResult {
  message: string;
  added: string[];
  alreadyPresent: string[];
  removed: string[];
  notFound: string[];
  stored: string[];
  sessionIgnores: string[];
  configIgnores: string[];
}

/**
 * Run the `/df-ignore` hotlist command: session add/remove in place (the
 * caller's live array, so the shared glob-matcher cache stays hot),
 * optional `-s` persistence to the config file, `-l`/bare listing of both
 * sources. Storing writes the file but does not reload it — the caller
 * refreshes its in-memory config the way `/df-profile` does.
 */
export async function dfIgnore(
  directory: string,
  sessionIgnores: string[],
  config: ResolvedConfig,
  args: DfIgnoreArgs,
): Promise<DfIgnoreResult> {
  const added: string[] = [];
  const alreadyPresent: string[] = [];
  const removed: string[] = [];
  const notFound: string[] = [];
  let stored: string[] = [];

  for (const pattern of args.remove) {
    const index = sessionIgnores.indexOf(pattern);
    if (index !== -1) {
      sessionIgnores.splice(index, 1);
      removed.push(pattern);
    } else {
      notFound.push(pattern);
    }
  }
  for (const pattern of args.patterns) {
    if (sessionIgnores.includes(pattern)) {
      alreadyPresent.push(pattern);
    } else {
      sessionIgnores.push(pattern);
      added.push(pattern);
    }
  }
  const lines: string[] = [];
  if (added.length > 0) {
    lines.push(`Ignored for this session: ${added.join(", ")}.`);
  }
  if (alreadyPresent.length > 0) {
    lines.push(`Already ignored this session: ${alreadyPresent.join(", ")}.`);
  }
  if (removed.length > 0) {
    lines.push(`Removed from session ignores: ${removed.join(", ")}.`);
  }
  if (notFound.length > 0) {
    lines.push(`Not in session ignores: ${notFound.join(", ")}.`);
  }
  if (args.store) {
    const toStore = args.patterns.length > 0 ? args.patterns : [...sessionIgnores];
    if (toStore.length > 0) {
      const configPath = existingConfigPath(directory) ?? join(directory, ".dev-framework.yml");
      stored = await storeGateIgnores(configPath, toStore);
    } else {
      lines.push(`Nothing to store.`);
    }
  }

  // Post-store snapshot: `stored` holds exactly what the file gained, so
  // the list line reflects the disk state the adapters reload right after.
  const configIgnores = [...config.gate.ignore, ...stored];
  if (args.store && stored.length > 0) {
    lines.push(`Stored permanently (gate.ignore): ${stored.join(", ")}.`);
  } else if (args.store && lines[lines.length - 1] !== `Nothing to store.`) {
    lines.push(`Nothing new to store — already in gate.ignore.`);
  }
  if (args.list || lines.length === 0) {
    const session = sessionIgnores.length > 0 ? sessionIgnores.join(", ") : "(none)";
    const storedList = configIgnores.length > 0 ? configIgnores.join(", ") : "(none)";
    lines.push(`Session ignores: ${session}. Config gate.ignore: ${storedList}.`);
  } else if (!args.store) {
    lines.push(`Session-scoped only; re-run with -s to store permanently.`);
  }
  return {
    message: lines.join(" "),
    added,
    alreadyPresent,
    removed,
    notFound,
    stored,
    sessionIgnores: [...sessionIgnores],
    configIgnores,
  };
}
