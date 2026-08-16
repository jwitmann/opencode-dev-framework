import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { DEFAULT_PROTECT } from "./config.js";
import { detectProject } from "./detect.js";
import type { CommandsConfig, Profile } from "./types.js";

/** Directory containing the project templates shipped with the package. */
export const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "templates");

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
  lines.push("  timeout: 300");
  lines.push("  max_blocks: 3");
  lines.push("");
  lines.push("on_edit:");
  lines.push("  format: true");
  lines.push("  lint: true");
  return lines.join("\n");
}

/**
 * Write a project-level `.opencode-dev-framework.yml` based on detected
 * tooling. Respects the same overwrite/skip flags and prompt as
 * `installTemplates`.
 */
export async function writeDetectedConfig(
  targetDir: string,
  options: InstallOptions = {},
): Promise<ConfigWriteResult> {
  const { language, commands, hasPreCommitConfig } = detectProject(targetDir);
  const content = buildDefaultConfigYaml(language, commands, hasPreCommitConfig);
  const destination = join(targetDir, ".opencode-dev-framework.yml");
  const relativePath = ".opencode-dev-framework.yml";

  const exists = await fileExists(destination);
  if (!exists) {
    await fs.writeFile(destination, content, "utf8");
    return { action: "created" };
  }

  const existing = await readFileSafe(destination);
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

/** Resolve a user-supplied directory (default cwd) to an absolute path. */
export function resolveTargetDir(dir?: string): string {
  return resolve(dir ?? process.cwd());
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
