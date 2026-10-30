import picomatch from "picomatch";
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

export interface GlobMatcher {
  pattern: string;
  match: (candidate: string) => boolean;
}

/**
 * Compile glob patterns to picomatch matchers, cached by pattern-array
 * identity. Compilation is the expensive part; the per-tool-call hot path
 * pays matching only. A re-resolved config carries new arrays and naturally
 * recompiles once. Shared by protected-path and exclude matching so the
 * cache scheme exists exactly once.
 */
const globMatcherCache = new WeakMap<readonly string[], GlobMatcher[]>();

export function compileGlobMatchers(patterns: readonly string[]): GlobMatcher[] {
  const cached = globMatcherCache.get(patterns);
  if (cached !== undefined) {
    return cached;
  }
  const compiled = patterns.map((pattern) => ({
    pattern,
    match: picomatch(pattern, { dot: true }),
  }));
  globMatcherCache.set(patterns, compiled);
  return compiled;
}
