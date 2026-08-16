import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedConfig } from "./types.js";

/**
 * Directory containing the constitution bundled with the plugin package.
 * Built code lives in `dist/`, so `../rules` resolves to the package root at
 * runtime; during tests (ts source) it resolves the same way relative to
 * `src/`.
 */
export const BUNDLED_CONSTITUTION_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "rules",
);

/**
 * Kept for backward compatibility with tests and docs. The bundled
 * constitution is now loaded from all `.md` files in `BUNDLED_CONSTITUTION_DIR`.
 */
export const BUNDLED_CONSTITUTION_PATH = join(BUNDLED_CONSTITUTION_DIR, "constitution.md");

export interface ConstitutionResult {
  /** Constitution text to inject, or null when nothing should be injected. */
  constitution: string | null;
  source: "custom" | "bundled" | null;
  /** Human-readable warning when a configured constitution could not be read. */
  warning?: string;
}

async function readConstitution(path: string): Promise<string | null> {
  try {
    const content = await readFile(path, "utf8");
    return content.trim() === "" ? null : content;
  } catch {
    return null;
  }
}

/**
 * Reads all `.md` files in a directory and concatenates them in sorted order,
 * separated by blank lines. Returns null when the directory is missing or
 * contains no non-empty markdown files.
 */
async function readConstitutionDir(dir: string): Promise<string | null> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort();
    if (files.length === 0) {
      return null;
    }
    const parts: string[] = [];
    for (const name of files) {
      const content = await readFile(join(dir, name), "utf8");
      if (content.trim() !== "") {
        parts.push(content.trim());
      }
    }
    return parts.length === 0 ? null : parts.join("\n\n");
  } catch {
    return null;
  }
}

async function readRulesFiles(
  paths: string[],
  directory: string,
): Promise<{ content: string | null; warnings: string[] }> {
  const parts: string[] = [];
  const warnings: string[] = [];
  for (const rawPath of paths) {
    const path = isAbsolute(rawPath) ? rawPath : resolve(directory, rawPath);
    const content = await readConstitution(path);
    if (content !== null) {
      parts.push(content);
    } else {
      warnings.push(`Could not read rule file ${path}; skipping.`);
    }
  }
  return { content: parts.length === 0 ? null : parts.join("\n\n"), warnings };
}

/**
 * Loads the constitution to inject for a session.
 *
 * - `off` profile never injects anything.
 * - A configured `constitution` path wins and replaces everything else (bundled
 *   rules and `rules` are ignored).
 * - Without `constitution`:
 *   - `rules` with `mode: replace` (the default) loads only those rule files.
 *   - `rules` with `mode: append` loads the bundled constitution first, then
 *     the listed rule files.
 *   - If neither `constitution` nor `rules` is set, the bundled constitution is
 *     used.
 * - Missing rule files produce warnings but do not stop other files from
 *   loading.
 * - When the bundled constitution directory itself cannot be read and no
 *   custom source is available, nothing is injected and a warning is returned.
 */
export async function loadConstitution(
  config: ResolvedConfig,
  directory?: string,
): Promise<ConstitutionResult> {
  if (config.profile === "off") {
    return { constitution: null, source: null };
  }

  const warnings: string[] = [];
  const parts: string[] = [];
  let source: ConstitutionResult["source"] = null;

  if (config.constitution) {
    const customPath = isAbsolute(config.constitution)
      ? config.constitution
      : resolve(directory ?? process.cwd(), config.constitution);
    const custom = await readConstitution(customPath);
    if (custom !== null) {
      parts.push(custom);
      source = "custom";
    } else {
      const bundled = await readConstitutionDir(BUNDLED_CONSTITUTION_DIR);
      if (bundled !== null) {
        parts.push(bundled);
        source = "bundled";
      }
      warnings.push(
        `Could not read configured constitution at ${customPath}; using bundled constitution.`,
      );
    }
  } else if (config.rules && config.rules.files.length > 0) {
    const rulesResult = await readRulesFiles(config.rules.files, directory ?? process.cwd());
    if (rulesResult.content !== null) {
      parts.push(rulesResult.content);
      source = "custom";
    }
    warnings.push(...rulesResult.warnings);
    if (config.rules.mode === "append") {
      const bundled = await readConstitutionDir(BUNDLED_CONSTITUTION_DIR);
      if (bundled !== null) {
        // Prepend bundled content so the explicit rules come last.
        parts.unshift(bundled);
        source = "bundled";
      }
    }
  } else {
    const bundled = await readConstitutionDir(BUNDLED_CONSTITUTION_DIR);
    if (bundled !== null) {
      parts.push(bundled);
      source = "bundled";
    }
  }

  if (parts.length === 0) {
    return {
      constitution: null,
      source: null,
      warning:
        warnings.length > 0
          ? warnings.join("\n")
          : "Could not read the bundled constitution; no constitution injected.",
    };
  }

  return {
    constitution: parts.join("\n\n"),
    source,
    warning: warnings.length > 0 ? warnings.join("\n") : undefined,
  };
}

/**
 * Appends the constitution to a system-prompt array, unless it is already
 * present (exact entry match or contained in an existing entry).
 */
export function injectConstitution(system: string[], constitution: string | null): string[] {
  if (constitution === null) {
    return system;
  }
  if (system.some((entry) => entry.includes(constitution))) {
    return system;
  }
  return [...system, constitution];
}
