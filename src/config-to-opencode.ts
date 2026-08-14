/**
 * Translate resolved framework config into OpenCode-native config fragments.
 *
 * The plugin never rewrites `opencode.json` on disk; these fragments are
 * returned as plain objects so callers (or tests) can inspect or apply them.
 * See docs/plans/02-architecture.md ("Tool guardrails") and the OpenCode
 * permissions/formatters docs.
 */

import type { CommandMap, ResolvedConfig } from "./types.js";

export type PermissionAction = "allow" | "ask" | "deny";

export interface PermissionConfig {
  edit?: Record<string, PermissionAction>;
  bash?: Record<string, PermissionAction>;
}

export interface FormatterEntry {
  command: string[];
  extensions?: string[];
  disabled?: boolean;
}

export type FormatterConfig = Record<string, FormatterEntry>;

export interface OpenCodeFragments {
  permission?: PermissionConfig;
  formatter?: FormatterConfig;
}

/**
 * Generate an OpenCode `permission` fragment from protected paths.
 *
 * Deny rules are only emitted when protection is active and
 * `protect_mode` is `deny`. In `warn` mode the plugin hook logs a warning
 * instead, since the native permission model has no "warn" action.
 */
export function generatePermission(config: ResolvedConfig): PermissionConfig {
  if (
    config.profile === "off" ||
    config.protect_off ||
    config.protect_mode !== "deny" ||
    config.protect.length === 0
  ) {
    return {};
  }
  const edit: Record<string, PermissionAction> = { "*": "allow" };
  for (const glob of config.protect) {
    edit[glob] = "deny";
  }
  return { edit };
}

interface NormalizedCommandMap {
  default?: string;
  byExtension: Record<string, string>;
}

export function normalizeCommandMap(map: CommandMap | undefined): NormalizedCommandMap {
  if (map === undefined) {
    return { byExtension: {} };
  }
  if (typeof map === "string") {
    return { default: map, byExtension: {} };
  }
  return { byExtension: map };
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

/** Substitute the `{file}` token with OpenCode's `$FILE` placeholder. */
function substituteFileToken(tokens: string[]): string[] {
  return tokens.map((token) => token.replaceAll("{file}", "$FILE"));
}

function formatterName(kind: string, ext?: string): string {
  if (ext === undefined) {
    return `dev-framework-${kind}`;
  }
  const suffix = ext.replace(/[^a-zA-Z0-9]/g, "-").replace(/^-+|-+$/g, "");
  return `dev-framework-${kind}-${suffix}`;
}

/**
 * Generate an OpenCode `formatter` fragment from `commands.format`.
 * Per-extension overrides become named formatter entries scoped to that
 * extension; a plain string becomes a formatter applying to all files.
 */
export function generateFormatter(config: ResolvedConfig): FormatterConfig {
  const { default: defaultCommand, byExtension } = normalizeCommandMap(config.commands.format);
  const formatter: FormatterConfig = {};

  for (const [ext, command] of Object.entries(byExtension)) {
    formatter[formatterName("format", ext)] = {
      command: substituteFileToken(splitCommand(command)),
      extensions: [ext],
    };
  }
  if (defaultCommand !== undefined) {
    formatter[formatterName("format")] = {
      command: substituteFileToken(splitCommand(defaultCommand)),
    };
  }
  return formatter;
}

/**
 * Build all OpenCode-native fragments for a resolved config. Empty
 * fragments are omitted from the result.
 */
export function toOpenCodeFragments(config: ResolvedConfig): OpenCodeFragments {
  // The off profile disables the plugin entirely: no native fragments.
  if (config.profile === "off") {
    return {};
  }
  const fragments: OpenCodeFragments = {};
  const permission = generatePermission(config);
  if (Object.keys(permission).length > 0) {
    fragments.permission = permission;
  }
  const formatter = generateFormatter(config);
  if (Object.keys(formatter).length > 0) {
    fragments.formatter = formatter;
  }
  return fragments;
}
