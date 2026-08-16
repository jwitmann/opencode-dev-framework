import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

/** Directory containing the project templates shipped with the package. */
export const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "templates");

export type OverwriteDecision = "overwrite" | "skip";

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
      return "overwrite";
    }
    if (normalized === "n" || normalized === "none") {
      return "skip";
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
    if (options.skipExisting) {
      decision = "skip";
    } else if (options.overwriteExisting) {
      decision = "overwrite";
    } else {
      decision = await prompt(relative);
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

/** Resolve a user-supplied directory (default cwd) to an absolute path. */
export function resolveTargetDir(dir?: string): string {
  return resolve(dir ?? process.cwd());
}
