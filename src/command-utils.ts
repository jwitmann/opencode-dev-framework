import type { CommandMap } from "./types.js";

export interface NormalizedCommandMap {
  default?: string;
  byExtension: Record<string, string>;
}

/**
 * Normalize a command map: a plain string becomes the default command; a record
 * may contain a `default` key plus per-extension overrides.
 */
export function normalizeCommandMap(map: CommandMap | undefined): NormalizedCommandMap {
  if (map === undefined) {
    return { byExtension: {} };
  }
  if (typeof map === "string") {
    return { default: map, byExtension: {} };
  }
  const { default: defaultCommand, ...byExtension } = map;
  return defaultCommand === undefined ? { byExtension } : { default: defaultCommand, byExtension };
}

/** Split a command string into argv tokens, honoring simple quotes. */
export function splitCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (const ch of command) {
    if (quote !== undefined) {
      if (ch === quote) {
        quote = undefined;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current !== "") {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current !== "") {
    tokens.push(current);
  }
  return tokens;
}
