import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { type Document, isMap, isScalar, isSeq, parseDocument } from "yaml";
import { splitCommand } from "./command-utils.js";
import {
  checkConfigEnforceable,
  DEFAULT_PROTECT,
  existingConfigPath,
  resolveConfig,
} from "./config.js";
import { detectProject } from "./detect.js";
import type { CommandResult, RunCommand } from "./host.js";
import type { CommandsConfig, Profile } from "./types.js";

/** Directory containing the project templates shipped with the package. */
export const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "templates");

export type OverwriteDecision = "overwrite" | "skip" | "overwrite-all" | "skip-all";

export type PromptFn = (relativePath: string) => Promise<OverwriteDecision>;

export interface InstallOptions {
  /** How to handle files that already exist with different content. */
  overwriteExisting?: boolean;
  /** Non-interactive mode: never prompt. Defaults to skip when false. */
  skipExisting?: boolean;
  /** Custom prompt function for interactive installs. */
  prompt?: PromptFn;
}

export interface InstallResult {
  created: string[];
  skipped: string[];
  overwritten: string[];
}

export interface TemplateStatus {
  missing: string[];
  present: string[];
  different: string[];
}

/**
 * DSH skill roots scanned by the host skill-filesystem provider, highest
 * rank first. `.opencode/skills` (the OpenCode layout `installTemplates`
 * writes) is not among them, so a DSH `df-init` must mirror the bundled
 * skills here or the `skill` tool never catalogs them and the setup brief
 * names something the agent cannot load — the framework would not start.
 */
export const DSH_SKILL_ROOTS = [".dsh/skills", ".agents/skills"] as const;

/**
 * Mirror the bundled `.opencode/skills` templates into a DSH-scanned skill
 * root so the host `skill` tool catalogs them. Same skip/overwrite
 * semantics as `installTemplates`: never clobber user files unasked.
 * Returns created/skipped/overwritten paths relative to the target dir.
 * `statusTemplates` only iterates the template set, so these copies never
 * read as drift.
 */
export async function mirrorSkillsToDsh(
  targetDir: string,
  root: string = DSH_SKILL_ROOTS[0],
  options: InstallOptions = {},
): Promise<InstallResult> {
  const result: InstallResult = { created: [], skipped: [], overwritten: [] };
  const prompt = options.prompt ?? defaultPrompt;
  /** Sticky decision set when the user answers "all" or "none". */
  let stickyDecision: "overwrite" | "skip" | null = null;

  // Loud like `listTemplateFiles`: a missing/unreadable skills dir is
  // packaging breakage, and silence would present a clean init whose brief
  // names a skill the host can never catalog.
  const names = await listSkillNames();
  const skillsDir = join(TEMPLATES_DIR, ".opencode", "skills");

  for (const name of names) {
    const source = join(skillsDir, name, "SKILL.md");
    const sourceContent = await readFileSafe(source);
    if (sourceContent === null) {
      continue;
    }
    const relative = `${root}/${name}/SKILL.md`;
    const destination = join(targetDir, relative);

    if (!(await fileExists(destination))) {
      await fs.mkdir(dirname(destination), { recursive: true });
      await fs.writeFile(destination, sourceContent, "utf8");
      result.created.push(relative);
      continue;
    }

    if ((await readFileSafe(destination)) === sourceContent) {
      result.skipped.push(relative);
      continue;
    }

    let decision: OverwriteDecision;
    if (stickyDecision !== null) {
      decision = stickyDecision;
    } else if (options.skipExisting) {
      decision = "skip";
    } else if (options.overwriteExisting) {
      decision = "overwrite";
    } else {
      decision = await prompt(relative);
    }

    if (decision === "overwrite-all") {
      stickyDecision = "overwrite";
      decision = "overwrite";
    } else if (decision === "skip-all") {
      stickyDecision = "skip";
      decision = "skip";
    }

    if (decision === "overwrite") {
      await fs.writeFile(destination, sourceContent, "utf8");
      result.overwritten.push(relative);
    } else {
      result.skipped.push(relative);
    }
  }

  return result;
}

/** List the bundled skill names (subdirectories of `.opencode/skills`). */
export async function listSkillNames(): Promise<string[]> {
  const skillsDir = join(TEMPLATES_DIR, ".opencode", "skills");
  return (await fs.readdir(skillsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** List all template files relative to TEMPLATES_DIR. */
export async function listTemplateFiles(): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), relative);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  }

  await walk(TEMPLATES_DIR, "");
  return files.sort();
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function defaultPrompt(relativePath: string): Promise<OverwriteDecision> {
  if (!process.stdin.isTTY) {
    return "skip";
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(
        `File exists with different content: ${relativePath}\nOverwrite? [o]verwrite / [s]kip / [a]ll / [n]one: `,
        resolve,
      );
    });
    const normalized = answer.trim().toLowerCase();
    if (normalized === "o" || normalized === "overwrite") {
      return "overwrite";
    }
    if (normalized === "s" || normalized === "skip") {
      return "skip";
    }
    if (normalized === "a" || normalized === "all") {
      return "overwrite-all";
    }
    if (normalized === "n" || normalized === "none") {
      return "skip-all";
    }
    return "skip";
  } finally {
    rl.close();
  }
}

/**
 * Install all bundled templates into a target project directory.
 * Returns lists of created, skipped, and overwritten files (relative paths).
 */
export async function installTemplates(
  targetDir: string,
  options: InstallOptions = {},
): Promise<InstallResult> {
  const result: InstallResult = { created: [], skipped: [], overwritten: [] };
  const files = await listTemplateFiles();
  const prompt = options.prompt ?? defaultPrompt;
  /** Sticky decision set when the user answers "all" or "none". */
  let stickyDecision: "overwrite" | "skip" | null = null;

  for (const relative of files) {
    const source = join(TEMPLATES_DIR, relative);
    const destination = join(targetDir, relative);
    const sourceContent = await readFileSafe(source);
    if (sourceContent === null) {
      continue;
    }

    if (!(await fileExists(destination))) {
      await fs.mkdir(dirname(destination), { recursive: true });
      await fs.writeFile(destination, sourceContent, "utf8");
      result.created.push(relative);
      continue;
    }

    const existing = await readFileSafe(destination);
    if (existing === sourceContent) {
      result.skipped.push(relative);
      continue;
    }

    let decision: OverwriteDecision;
    if (stickyDecision !== null) {
      decision = stickyDecision;
    } else if (options.skipExisting) {
      decision = "skip";
    } else if (options.overwriteExisting) {
      decision = "overwrite";
    } else {
      decision = await prompt(relative);
    }

    if (decision === "overwrite-all") {
      stickyDecision = "overwrite";
      decision = "overwrite";
    } else if (decision === "skip-all") {
      stickyDecision = "skip";
      decision = "skip";
    }

    if (decision === "overwrite") {
      await fs.writeFile(destination, sourceContent, "utf8");
      result.overwritten.push(relative);
    } else {
      result.skipped.push(relative);
    }
  }

  return result;
}

/**
 * Compare a skill mirror root against its `.opencode/skills` sources.
 * Returns mirror-relative drift: absent mirrors read as `add`, differing
 * ones as `refresh`. Orphaned mirrors (no template source — a skill the
 * shipment dropped) are ignored: never nag about files we no longer ship.
 * Like `statusTemplates`, a broken source dir throws instead of reading
 * as clean. Shares the `TemplateStatus` shape so drift merges trivially.
 */
export async function statusMirror(
  targetDir: string,
  root: string = DSH_SKILL_ROOTS[0],
): Promise<TemplateStatus> {
  const drift: TemplateStatus = { present: [], different: [], missing: [] };
  const skillsDir = join(TEMPLATES_DIR, ".opencode", "skills");
  for (const name of await listSkillNames()) {
    const sourceContent = await readFileSafe(join(skillsDir, name, "SKILL.md"));
    if (sourceContent === null) {
      continue;
    }
    const relative = `${root}/${name}/SKILL.md`;
    const existing = await readFileSafe(join(targetDir, relative));
    if (existing === null) {
      drift.missing.push(relative);
    } else if (existing === sourceContent) {
      drift.present.push(relative);
    } else {
      drift.different.push(relative);
    }
  }
  return drift;
}

/**
 * Compare the target project against the bundled templates.
 */
export async function statusTemplates(targetDir: string): Promise<TemplateStatus> {
  const files = await listTemplateFiles();
  const status: TemplateStatus = { missing: [], present: [], different: [] };

  for (const relative of files) {
    const source = join(TEMPLATES_DIR, relative);
    const destination = join(targetDir, relative);
    const sourceContent = await readFileSafe(source);
    const existing = await readFileSafe(destination);

    if (existing === null) {
      status.missing.push(relative);
    } else if (existing === sourceContent) {
      status.present.push(relative);
    } else {
      status.different.push(relative);
    }
  }

  return status;
}

export interface ConfigWriteResult {
  action: "created" | "skipped" | "overwritten";
}

function buildDefaultConfigYaml(
  language: string | null,
  commands: CommandsConfig,
  hasPreCommitConfig: boolean,
): string {
  const lines: string[] = ["# opencode-dev-framework configuration"];
  lines.push("# Edit the commands to match your project's toolchain.");
  lines.push("");
  lines.push("profile: standard");
  if (language !== null) {
    lines.push(`# Detected language: ${language}`);
  }
  if (Object.keys(commands).length > 0) {
    lines.push("commands:");
    if (commands.test !== undefined) lines.push(`  test: ${commands.test}`);
    if (commands.typecheck !== undefined) lines.push(`  typecheck: ${commands.typecheck}`);
    if (commands.format !== undefined) {
      if (typeof commands.format === "string") {
        lines.push(`  format: ${commands.format}`);
      } else {
        lines.push("  format:");
        for (const [ext, cmd] of Object.entries(commands.format)) {
          lines.push(`    ${ext}: ${cmd}`);
        }
      }
    }
    if (commands.lint !== undefined) {
      if (typeof commands.lint === "string") {
        lines.push(`  lint: ${commands.lint}`);
      } else {
        lines.push("  lint:");
        for (const [ext, cmd] of Object.entries(commands.lint)) {
          lines.push(`    ${ext}: ${cmd}`);
        }
      }
    }
    if (commands.test_changed !== undefined) lines.push(`  test_changed: ${commands.test_changed}`);
  }
  if (hasPreCommitConfig) {
    lines.push("");
    lines.push("# Pre-commit config detected; use it for per-file linting.");
    lines.push("precommit: auto");
  }
  lines.push("");
  lines.push("protect:");
  for (const pattern of DEFAULT_PROTECT) {
    lines.push(`  - "${pattern}"`);
  }
  lines.push("");
  lines.push("exclude: []");
  lines.push("");
  lines.push("gate:");
  lines.push("  run_typecheck: true");
  lines.push("  run_tests: true");
  lines.push("  block_on_failure: true");
  lines.push("  skip_unchanged: true");
  lines.push("  scope: all");
  lines.push("  lint_changed: false");
  lines.push("  # standard/strict default: sessions that changed files must produce a");
  lines.push("  # peer-review artifact (.dev-framework/review.md).");
  lines.push("  require_review: true");
  lines.push("  timeout: 300");
  lines.push("  max_blocks: 3");
  lines.push("");
  lines.push("# Optional: pre-flight task list. When set, edit tools are denied");
  lines.push("# (standard/strict) until the agent writes its findings to");
  lines.push("# .dev-framework/preflight.md. Use for work that");
  lines.push("# must establish baseline state/knowledge before editing.");
  lines.push("# preflight:");
  lines.push('#   - "Summarize the current state of the component you will change"');
  lines.push('#   - "Record the baseline metrics this work will be judged against"');
  lines.push("");
  lines.push("on_edit:");
  lines.push("  format: true");
  lines.push("  lint: true");
  return lines.join("\n");
}

/**
 * Write a project-level `.dev-framework.yml` based on detected
 * tooling. Respects the same overwrite/skip flags and prompt as
 * `installTemplates`. An existing legacy `.opencode-dev-framework.yml`
 * is left alone (the loader still reads it) — new files use the
 * neutral name.
 */
export async function writeDetectedConfig(
  targetDir: string,
  options: InstallOptions = {},
): Promise<ConfigWriteResult> {
  const { language, commands, hasPreCommitConfig } = detectProject(targetDir);
  const content = buildDefaultConfigYaml(language, commands, hasPreCommitConfig);
  // Honor the deployment's established name: a config under any supported
  // name keeps its name (no shadowing duplicate); new deployments get the
  // neutral one.
  const destination = existingConfigPath(targetDir) ?? join(targetDir, ".dev-framework.yml");
  const relativePath = destination.slice(targetDir.length + 1);

  const existing = await readFileSafe(destination);
  if (existing === null) {
    await fs.writeFile(destination, content, "utf8");
    return { action: "created" };
  }
  if (existing === content) {
    return { action: "skipped" };
  }

  const prompt = options.prompt ?? defaultPrompt;
  let decision: OverwriteDecision;
  if (options.skipExisting) {
    decision = "skip";
  } else if (options.overwriteExisting) {
    decision = "overwrite";
  } else {
    decision = await prompt(relativePath);
  }

  if (decision === "overwrite-all") {
    decision = "overwrite";
  } else if (decision === "skip-all") {
    decision = "skip";
  }

  if (decision === "overwrite") {
    await fs.writeFile(destination, content, "utf8");
    return { action: "overwritten" };
  }
  return { action: "skipped" };
}

/** Bounded trial-run timeout (seconds): init UX, not a gate suite. */
export const TRIAL_RUN_TIMEOUT_SECONDS = 120;

export interface TrialRunResult {
  name: "test" | "typecheck";
  command: string;
  ok: boolean;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  /** Spawn failure detail (run threw instead of resolving). */
  error?: string;
}

/**
 * Run each runnable detected command once to verify the guess (plan 15).
 * Only `test`/`typecheck` run bare — lint/format templates carry
 * `{file}`/`{dir}` placeholders and are reported as unverified by the
 * caller skipping them (absent or empty commands are skipped, not failed).
 * The two trials run concurrently; each is bounded by `timeout` seconds.
 * Report-only by construction: results annotate, never throw — including
 * for runners that reject despite the host never-rejects contract.
 */
export async function trialRunDetectedCommands(
  directory: string,
  commands: { test?: string; typecheck?: string },
  run: RunCommand,
  opts: { timeout?: number } = {},
): Promise<TrialRunResult[]> {
  const entries = [
    ["test", commands.test],
    ["typecheck", commands.typecheck],
  ] as const;
  const runnable: { name: "test" | "typecheck"; command: string }[] = [];
  for (const [name, template] of entries) {
    if (typeof template === "string" && template !== "") runnable.push({ name, command: template });
  }
  return Promise.all(
    runnable.map(async ({ name, command }): Promise<TrialRunResult> => {
      const started = Date.now();
      let result: CommandResult;
      try {
        result = await run(splitCommand(command), {
          cwd: directory,
          timeout: opts.timeout ?? TRIAL_RUN_TIMEOUT_SECONDS,
        });
      } catch (error) {
        return {
          name,
          command,
          ok: false,
          exitCode: 127,
          timedOut: false,
          durationMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      return {
        name,
        command,
        ok: result.exitCode === 0 && !result.timedOut,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: Date.now() - started,
      };
    }),
  );
}

/** Render trial-run results as CLI/tool output lines. */
export function formatTrialRun(results: TrialRunResult[]): string[] {
  if (results.length === 0) {
    return ["Trial-run: no runnable commands detected — verify manually."];
  }
  return [
    "Trial-run:",
    ...results.map((r) => {
      const secs = (r.durationMs / 1000).toFixed(1);
      if (r.error !== undefined) {
        return `  ${r.name} (${r.command}): ERROR (${r.error}) — verify this command`;
      }
      const status = r.ok ? "PASS" : `FAIL (exit ${r.exitCode}${r.timedOut ? ", timed out" : ""})`;
      const suffix = r.ok ? "" : " — verify this command";
      return `  ${r.name} (${r.command}): ${status} (${secs}s)${suffix}`;
    }),
  ];
}

/** Resolve a user-supplied directory (default cwd) to an absolute path. */
export function resolveTargetDir(dir?: string): string {
  return resolve(dir ?? process.cwd());
}

/**
 * List Makefile target names (plan 16). Names only, no semantics: the
 * agent decides which (if any) are canonical wrappers. Capped at 30.
 * Grouped targets (`lint test: deps`) split into both names; pattern
 * rules, dot-directives, assignments, and make keywords never match.
 * Probes GNUmakefile/makefile/Makefile in GNU make precedence order.
 * Empty when no makefile exists or none is readable — report-only.
 */
export async function listMakefileTargets(directory: string): Promise<string[]> {
  let content: string | null = null;
  for (const name of ["GNUmakefile", "makefile", "Makefile"]) {
    try {
      content = await fs.readFile(join(directory, name), "utf8");
      break;
    } catch {
      // Not present or unreadable — try the next name.
    }
  }
  if (content === null) return [];
  const keywords =
    /^(export|unexport|override|define|endef|ifeq|ifneq|ifdef|ifndef|else|endif|include|-include|sinclude)$/;
  const namePattern = /^[A-Za-z0-9_][A-Za-z0-9_.%-]*$/;
  const targets: string[] = [];
  for (const line of content.split("\n")) {
    // Leading char excludes comments, recipes, dot-directives, and `%`
    // pattern rules; `[^:=]` keeps the match left of any assignment.
    const match = /^([^:#=\s][^:=]*?)\s*:(?!=)/.exec(line);
    if (match === null) continue;
    for (const token of match[1].split(/\s+/)) {
      if (!namePattern.test(token) || keywords.test(token) || targets.includes(token)) continue;
      targets.push(token);
      if (targets.length >= 30) break;
    }
    if (targets.length >= 30) break;
  }
  return targets;
}

export interface WizardBrief {
  language: string | null;
  commands: { test?: string; typecheck?: string };
  trial: TrialRunResult[];
  makeTargets: string[];
  enforceability: { ok: true } | { ok: false; error: string };
  /** Open questions for the agent, capped at 3 — never exhaustive. */
  questions: string[];
}

/**
 * Build the agent-handoff brief (plan 16): detection, trial-run, Makefile
 * target names, and the shared enforceability verdict in one bundle. The
 * LLM session agent is the wizard's presenter — this is the machine side,
 * hints only, and the project-config skill still verifies everything by
 * running. Trial/target failures annotate, never throw; a nonexistent
 * directory rejects via detection, so both callers isolate the brief in
 * try/catch (see `formatBriefSkipped`).
 */
export async function buildWizardBrief(
  directory: string,
  run: RunCommand,
  opts: { timeout?: number } = {},
): Promise<WizardBrief> {
  const { language, commands } = detectProject(directory);
  const [trial, makeTargets] = await Promise.all([
    trialRunDetectedCommands(directory, commands, run, opts),
    listMakefileTargets(directory),
  ]);
  const enforceability = checkConfigEnforceable(resolveConfig({ profile: "standard", commands }));
  const questions: string[] = [];
  if (makeTargets.length > 0) {
    const shown = makeTargets.slice(0, 8).join(", ");
    questions.push(
      `Makefile targets detected (${shown}${makeTargets.length > 8 ? ", …" : ""}) — ` +
        "do canonical wrappers (e.g. make check/test/lint) replace the guessed bare commands?",
    );
  }
  for (const t of trial) {
    if (t.ok || questions.length >= 3) continue;
    questions.push(
      `Trial-run flagged ${t.name} (${t.command}) — verify the real command before trusting the guess.`,
    );
  }
  if (enforceability.ok === false && questions.length < 3) {
    questions.push(`Draft is not enforceable: ${enforceability.error}`);
  }
  return {
    language,
    commands,
    trial,
    makeTargets,
    enforceability,
    questions: questions.slice(0, 3),
  };
}

/** Shared report-only fallback when the brief itself cannot be built. */
export function formatBriefSkipped(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `Wizard brief: skipped (${detail}) — verify commands manually`;
}

/** Render the wizard brief as CLI/tool output lines, ending in the handoff. */
export function formatWizardBrief(brief: WizardBrief): string[] {
  const guessed = `Guessed commands: test=${brief.commands.test ?? "(none)"}, typecheck=${brief.commands.typecheck ?? "(none)"}`;
  const lines = [
    "Wizard brief (machine-generated hints — verify by running, see the project-config skill):",
    `Detected language: ${brief.language ?? "(unknown)"}`,
    guessed,
    ...formatTrialRun(brief.trial),
    brief.makeTargets.length > 0
      ? `Makefile targets: ${brief.makeTargets.join(", ")}`
      : "Makefile targets: (none — no Makefile)",
    brief.enforceability.ok
      ? "Enforceability: draft passes the shared bar (blocking profile + real checks)."
      : `Enforceability: FAIL — ${brief.enforceability.error}`,
  ];
  if (brief.questions.length > 0) {
    lines.push("Open questions (at most 3):", ...brief.questions.map((q, i) => `  ${i + 1}. ${q}`));
  }
  lines.push(
    "",
    "Handoff: follow the project-config skill (templates/.opencode/skills/project-config/SKILL.md) " +
      "to resolve the questions above, run the real commands, and present " +
      ".dev-framework.yml + .dev-framework/hardening.md for review. Do not write without review.",
  );
  return lines;
}

/**
 * Set the top-level `profile:` key in a config file. Edits the raw text
 * instead of re-serializing the YAML so user comments and formatting survive.
 */
export async function setProfileInFile(configPath: string, profile: Profile): Promise<void> {
  let content = "";
  try {
    content = await fs.readFile(configPath, "utf8");
  } catch {
    // File does not exist yet; it will be created below.
  }

  const line = `profile: ${profile}`;
  if (/^profile\s*:/m.test(content)) {
    content = content.replace(/^profile\s*:.*$/m, line);
  } else {
    content = content.trim() === "" ? `${line}\n` : `${content.trimEnd()}\n${line}\n`;
  }
  await fs.writeFile(configPath, content, "utf8");
}

/** Read a raw YAML/JSON value as a pattern list: strings split on
 * whitespace (flat `gate_ignore: "a b"` form), sequences as-is, anything
 * else as empty. YAML nodes arrive as `Seq`, not plain arrays — both are
 * handled. */
function toPatternList(value: unknown): string[] {
  if (typeof value === "string") {
    return value.split(/\s+/).filter((p) => p !== "");
  }
  const items = isSeq(value) ? value.items : Array.isArray(value) ? value : null;
  if (items === null) {
    return [];
  }
  return items
    .map((item) => (isScalar(item) ? String(item.value) : String(item)))
    .filter((p) => p !== "");
}

/**
 * Persist gate-ignore patterns to a config file, shape-aware: flat files
 * grow the `gate_ignore:` line, native files grow the `gate: ignore:`
 * sequence, scalar-only files (e.g. just `profile:`) gain a flat line,
 * and JSON files (native-only by design) grow `gate.ignore`. A missing
 * file is created flat. `parseDocument` round-trips the YAML so user
 * comments and formatting survive outside the edited node. Returns the
 * patterns newly stored (already-present ones are skipped, never
 * duplicated). Throws a readable error when the file exists but the
 * `gate:` value is not a mapping.
 */
export async function storeGateIgnores(configPath: string, patterns: string[]): Promise<string[]> {
  const fresh = patterns.map((p) => p.trim()).filter((p) => p !== "");
  if (fresh.length === 0) {
    return [];
  }
  if (configPath.endsWith(".json")) {
    return storeGateIgnoresJson(configPath, fresh);
  }
  let text = "";
  try {
    text = await fs.readFile(configPath, "utf8");
  } catch {
    // File does not exist yet; it will be created below.
  }
  const doc = parseDocument(text);
  if (doc.contents !== null && !isMap(doc.contents)) {
    throw new Error(`Cannot store gate ignores in ${configPath}: root is not a mapping.`);
  }
  const added: string[] = [];
  const union = (existing: string[]): string[] => {
    for (const p of fresh) {
      if (!existing.includes(p)) {
        existing.push(p);
        added.push(p);
      }
    }
    return existing;
  };
  // Same sniffing as `selectConfigRecord`: native-only keys (with
  // non-null values — the loader filters nulls, so `doc.has` alone would
  // over-count commented-out debris) or object-form `rules:` mean native
  // shape, so a new key must not introduce a flat line (which the loader
  // would reject as mixed-shape).
  const hasNativeKeys =
    doc.contents !== null &&
    (["commands", "gate", "on_edit"].some((key) => hasLiveKey(doc, key)) ||
      isMap(doc.get("rules", true)));
  if (!hasNativeKeys) {
    // Flat shape: values are space-separated on one line, so patterns
    // with spaces cannot round-trip — fail loudly instead of silently
    // storing two bogus patterns.
    const spaced = fresh.filter((p) => /\s/.test(p));
    if (spaced.length > 0) {
      throw new Error(
        `Cannot store ${spaced.join(", ")} in ${configPath}: flat-shape ignores are ` +
          `space-separated. Convert the config to native shape (a gate: ignore: list) first.`,
      );
    }
    if (doc.has("gate_ignore")) {
      doc.set("gate_ignore", union(toPatternList(doc.get("gate_ignore"))).join(" "));
    } else {
      doc.set("gate_ignore", fresh.join(" "));
      added.push(...fresh);
    }
  } else {
    // Null-valued `gate:` counts as absent (the loader filters nulls) —
    // only a non-null non-mapping gate is a real error.
    const gate = doc.get("gate", true);
    if (gate === undefined || gate === null || (isScalar(gate) && gate.value == null)) {
      doc.set("gate", { ignore: union([]) });
    } else if (!isMap(gate)) {
      throw new Error(`Cannot store gate ignores in ${configPath}: gate: is not a mapping.`);
    } else {
      gate.set("ignore", union(toPatternList(gate.get("ignore"))));
    }
  }
  await fs.writeFile(configPath, String(doc), "utf8");
  return added;
}

/** A key the loader's shape sniffing would count: present with a
 * non-null value (`doc.has` alone counts commented-out `key:` debris). */
function hasLiveKey(doc: Document, key: string): boolean {
  const node = doc.get(key, true);
  return node !== undefined && node !== null && !(isScalar(node) && node.value == null);
}

async function storeGateIgnoresJson(configPath: string, fresh: string[]): Promise<string[]> {
  let obj: Record<string, unknown> = {};
  try {
    const text = await fs.readFile(configPath, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Cannot store gate ignores in ${configPath}: root is not an object.`);
    }
    obj = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as { code?: unknown })?.code !== "ENOENT") {
      throw error;
    }
    // File does not exist yet; it will be created below.
  }
  const added: string[] = [];
  let gate: Record<string, unknown>;
  if (typeof obj.gate === "object" && obj.gate !== null && !Array.isArray(obj.gate)) {
    gate = obj.gate as Record<string, unknown>;
  } else {
    gate = {};
    obj.gate = gate;
  }
  const current = Array.isArray(gate.ignore) ? gate.ignore.map((item) => String(item)) : [];
  for (const p of fresh) {
    if (!current.includes(p)) {
      current.push(p);
      added.push(p);
    }
  }
  gate.ignore = current;
  await fs.writeFile(configPath, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
  return added;
}
