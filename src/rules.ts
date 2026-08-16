import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedConfig } from "./types.js";

/**
 * Directory containing the constitution bundled with the plugin package.
 * Built code lives in `dist/`, so `../rules` resolves to the package root at
 * runtime; during tests (ts source) it resolves the same way relative to `src/`.
 */
export const BUNDLED_CONSTITUTION_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "rules",
);

/** Namespaced directory inside the project for local rule overrides. */
export const LOCAL_RULES_DIR = ".opencode/opencode-dev-framework/rules";

/** Default style-guide filenames the plugin auto-discovers. */
export const STYLE_GUIDE_CANDIDATES = [
  "STYLE.md",
  "docs/STYLE.md",
  "CONTRIBUTING.md",
  "docs/CONTRIBUTING.md",
];

export interface ConstitutionResult {
  /** Constitution text to inject, or null when nothing should be injected. */
  constitution: string | null;
  source: "custom" | "bundled" | null;
  /** Human-readable warning when a configured rule file could not be read. */
  warning?: string;
}

async function readRuleFile(path: string): Promise<string | null> {
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
async function readRuleDir(dir: string): Promise<string | null> {
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
    const content = await readRuleFile(path);
    if (content !== null) {
      parts.push(content);
    } else {
      warnings.push(`Could not read rule file ${path}; skipping.`);
    }
  }
  return { content: parts.length === 0 ? null : parts.join("\n\n"), warnings };
}

async function discoverStyleGuide(directory: string): Promise<string | null> {
  for (const candidate of STYLE_GUIDE_CANDIDATES) {
    const content = await readRuleFile(resolve(directory, candidate));
    if (content !== null) {
      return content;
    }
  }
  return null;
}

/**
 * Loads the constitution to inject for a session.
 *
 * - `off` profile never injects anything.
 * - Explicit `rules` config wins:
 *   - `rules` as an array (or `mode: replace`) loads only those rule files.
 *   - `rules: { mode: append, files: [...] }` loads the bundled/local rules
 *     first, then the listed files.
 * - If no explicit `rules` config is set, the plugin auto-discovers
 *   `.opencode/opencode-dev-framework/rules/*.md` in the project root. If that
 *   directory exists and contains markdown files, it replaces the bundled
 *   rules.
 * - If no local override exists, the bundled `rules/*.md` files are used.
 * - Missing rule files produce warnings but do not stop other files from
 *   loading.
 * - `style_guide` config always wins. When it is not set, the plugin
 *   auto-discovers `STYLE.md`, `CONTRIBUTING.md`, `docs/STYLE.md`, or
 *   `docs/CONTRIBUTING.md` in the project root and appends it under a
 *   "Style Guide" heading.
 */
export async function loadConstitution(
  config: ResolvedConfig,
  directory?: string,
): Promise<ConstitutionResult> {
  if (config.profile === "off") {
    return { constitution: null, source: null };
  }

  const cwd = directory ?? process.cwd();
  const warnings: string[] = [];
  const parts: string[] = [];
  let source: ConstitutionResult["source"] = null;

  if (config.rules && config.rules.files.length > 0) {
    const rulesResult = await readRulesFiles(config.rules.files, cwd);
    if (rulesResult.content !== null) {
      parts.push(rulesResult.content);
      source = "custom";
    }
    warnings.push(...rulesResult.warnings);
    if (config.rules.mode === "append") {
      const local = await readRuleDir(resolve(cwd, LOCAL_RULES_DIR));
      const bundled = await readRuleDir(BUNDLED_CONSTITUTION_DIR);
      const base = local ?? bundled;
      if (base !== null) {
        parts.unshift(base);
        source = local !== null ? "custom" : "bundled";
      }
    }
  } else {
    const local = await readRuleDir(resolve(cwd, LOCAL_RULES_DIR));
    if (local !== null) {
      parts.push(local);
      source = "custom";
    } else {
      const bundled = await readRuleDir(BUNDLED_CONSTITUTION_DIR);
      if (bundled !== null) {
        parts.push(bundled);
        source = "bundled";
      }
    }
  }

  if (config.style_guide) {
    const stylePath = isAbsolute(config.style_guide)
      ? config.style_guide
      : resolve(cwd, config.style_guide);
    const style = await readRuleFile(stylePath);
    if (style !== null) {
      parts.push(`# Style Guide\n\n${style}`);
    } else {
      warnings.push(`Could not read style guide at ${stylePath}; skipping.`);
    }
  } else {
    const discovered = await discoverStyleGuide(cwd);
    if (discovered !== null) {
      parts.push(`# Style Guide\n\n${discovered}`);
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
