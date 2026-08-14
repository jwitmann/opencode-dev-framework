import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedConfig } from "./types.js";

/**
 * Location of the constitution bundled with the plugin package.
 * Built code lives in `dist/`, so `../rules/constitution.md` resolves to the
 * package root at runtime; during tests (ts source) it resolves the same way
 * relative to `src/`.
 */
export const BUNDLED_CONSTITUTION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "rules",
  "constitution.md",
);

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
 * Loads the constitution to inject for a session.
 *
 * - `off` profile never injects anything.
 * - A configured `constitution` path wins; if it cannot be read, a warning is
 *   returned and the bundled constitution is used as a fallback.
 * - When the bundled constitution itself cannot be read, nothing is injected
 *   and a warning is returned.
 */
export async function loadConstitution(
  config: ResolvedConfig,
  directory?: string,
): Promise<ConstitutionResult> {
  if (config.profile === "off") {
    return { constitution: null, source: null };
  }

  if (config.constitution) {
    const customPath = isAbsolute(config.constitution)
      ? config.constitution
      : resolve(directory ?? process.cwd(), config.constitution);
    const custom = await readConstitution(customPath);
    if (custom !== null) {
      return { constitution: custom, source: "custom" };
    }
    const bundled = await readConstitution(BUNDLED_CONSTITUTION_PATH);
    if (bundled !== null) {
      return {
        constitution: bundled,
        source: "bundled",
        warning: `Could not read configured constitution at ${customPath}; using bundled constitution.`,
      };
    }
    return {
      constitution: null,
      source: null,
      warning: `Could not read configured constitution at ${customPath} or the bundled constitution; no constitution injected.`,
    };
  }

  const bundled = await readConstitution(BUNDLED_CONSTITUTION_PATH);
  if (bundled !== null) {
    return { constitution: bundled, source: "bundled" };
  }
  return {
    constitution: null,
    source: null,
    warning: "Could not read the bundled constitution; no constitution injected.",
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
