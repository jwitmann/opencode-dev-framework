/**
 * Config loader for opencode-dev-framework.
 *
 * Implements the precedence, validation, and profile-default rules from
 * docs/plans/03-config-spec.md.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Config, Profile, ProtectMode, ResolvedConfig } from "./types.js";

/** Config file precedence, highest first. The first file found wins. */
export const CONFIG_FILE_PRECEDENCE = [
  ".opencode-dev-framework.yml",
  ".opencode-dev-framework.yaml",
  ".opencode-dev-framework.json",
  ".dev-framework.yml",
  ".dev-framework.yaml",
] as const;

const FALLBACK_FILES: ReadonlySet<string> = new Set([".dev-framework.yml", ".dev-framework.yaml"]);

/** Sensible default protected paths, used when `protect` is omitted. */
export const DEFAULT_PROTECT: string[] = [
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  "**/node_modules/**",
  "**/vendor/**",
];

const commandMapSchema = z.union([z.string(), z.record(z.string(), z.string())]);

const configSchema = z.object({
  profile: z.enum(["off", "advisory", "standard", "strict"]).optional(),
  commands: z
    .object({
      test: z.string().optional(),
      typecheck: z.string().optional(),
      format: commandMapSchema.optional(),
      lint: commandMapSchema.optional(),
      test_changed: z.string().optional(),
    })
    .optional(),
  protect: z.array(z.string()).optional(),
  protect_mode: z.enum(["warn", "deny"]).optional(),
  protect_off: z.boolean().optional(),
  gate: z
    .object({
      run_typecheck: z.boolean().optional(),
      run_tests: z.boolean().optional(),
      block_on_failure: z.boolean().optional(),
      skip_unchanged: z.boolean().optional(),
      scope: z.enum(["all", "changed"]).optional(),
      lint_changed: z.boolean().optional(),
      timeout: z.number().positive().optional(),
      max_blocks: z.number().int().positive().optional(),
    })
    .optional(),
  on_edit: z
    .object({
      format: z.boolean().optional(),
      lint: z.boolean().optional(),
    })
    .optional(),
  exclude: z.array(z.string()).optional(),
  constitution: z.string().optional(),
  rules: z
    .union([
      z.array(z.string()),
      z.object({
        mode: z.enum(["replace", "append"]),
        files: z.array(z.string()),
      }),
    ])
    .optional(),
  style_guide: z.string().optional(),
});

/** Find the highest-precedence config file in a directory, if any. */
export function findConfigFile(directory: string): string | undefined {
  for (const name of CONFIG_FILE_PRECEDENCE) {
    const candidate = join(directory, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Split a whitespace-separated glob string (or pass through an array). */
export function splitGlobs(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  if (typeof value === "string") {
    return value.split(/\s+/).filter(Boolean);
  }
  return [];
}

function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "yes" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "no" || normalized === "0") {
      return false;
    }
  }
  return undefined;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

/**
 * Map a flat-key `.dev-framework.yml` document onto the native config shape.
 * Unknown keys are ignored. See the compatibility table in
 * docs/plans/03-config-spec.md.
 */
export function mapFlatConfig(flat: Record<string, unknown>): Config {
  const config: Config = {};
  const commands: NonNullable<Config["commands"]> = {};
  const gate: NonNullable<Config["gate"]> = {};
  const onEdit: NonNullable<Config["on_edit"]> = {};
  const formatByExt: Record<string, string> = {};
  const lintByExt: Record<string, string> = {};

  const assignCommand = (target: Record<string, string>, keyPrefix: string, value: unknown) => {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const [ext, cmd] of Object.entries(value as Record<string, unknown>)) {
        target[ext] = String(cmd);
      }
      return true;
    }
    if (typeof value === "string") {
      commands[keyPrefix === "format" ? "format" : "lint"] = value;
      return true;
    }
    return false;
  };

  for (const [key, value] of Object.entries(flat)) {
    if (key.startsWith("format.")) {
      const ext = key.slice("format.".length);
      formatByExt[ext.startsWith(".") ? ext : `.${ext}`] = String(value);
      continue;
    }
    if (key.startsWith("lint.")) {
      const ext = key.slice("lint.".length);
      lintByExt[ext.startsWith(".") ? ext : `.${ext}`] = String(value);
      continue;
    }
    switch (key) {
      case "profile":
        config.profile = value as Config["profile"];
        break;
      case "test":
        commands.test = String(value);
        break;
      case "typecheck":
        commands.typecheck = String(value);
        break;
      case "format":
        assignCommand(formatByExt, "format", value);
        break;
      case "lint":
        assignCommand(lintByExt, "lint", value);
        break;
      case "test_changed":
        commands.test_changed = String(value);
        break;
      case "precommit":
        // Ignored in MVP.
        break;
      case "format_on_edit":
        onEdit.format = toBoolean(value);
        break;
      case "lint_on_edit":
        onEdit.lint = toBoolean(value);
        break;
      case "gate_run_typecheck":
        gate.run_typecheck = toBoolean(value);
        break;
      case "gate_run_tests":
        gate.run_tests = toBoolean(value);
        break;
      case "gate_block_on_failure":
        gate.block_on_failure = toBoolean(value);
        break;
      case "gate_skip_unchanged":
        gate.skip_unchanged = toBoolean(value);
        break;
      case "gate_scope":
        gate.scope = value === "changed" ? "changed" : value === "all" ? "all" : undefined;
        break;
      case "gate_lint_changed":
        gate.lint_changed = toBoolean(value);
        break;
      case "gate_timeout":
        gate.timeout = toNumber(value);
        break;
      case "gate_max_blocks":
        gate.max_blocks = toNumber(value);
        break;
      case "protect_off":
        config.protect_off = toBoolean(value);
        break;
      case "protect_mode":
        config.protect_mode = value as ProtectMode;
        break;
      case "protect":
        config.protect = splitGlobs(value);
        break;
      case "exclude":
        config.exclude = splitGlobs(value);
        break;
      case "constitution":
        config.constitution = String(value);
        break;
      case "rules":
        config.rules = { mode: "replace", files: splitGlobs(value) };
        break;
      case "style_guide":
        config.style_guide = String(value);
        break;
      default:
        // Unknown flat keys are ignored for forward compatibility.
        break;
    }
  }

  if (Object.keys(formatByExt).length > 0) {
    commands.format = formatByExt;
  }
  if (Object.keys(lintByExt).length > 0) {
    commands.lint = lintByExt;
  }
  if (Object.keys(commands).length > 0) {
    config.commands = commands;
  }
  if (Object.values(gate).some((v) => v !== undefined)) {
    config.gate = gate;
  }
  if (Object.values(onEdit).some((v) => v !== undefined)) {
    config.on_edit = onEdit;
  }
  return config;
}

interface ProfileDefaults {
  protect_mode: ProtectMode;
  block_on_failure: boolean;
  lint_changed: boolean;
  on_edit_format: boolean;
  on_edit_lint: boolean;
}

function profileDefaults(profile: Profile): ProfileDefaults {
  return {
    protect_mode: profile === "advisory" ? "warn" : "deny",
    block_on_failure: profile === "standard" || profile === "strict",
    lint_changed: profile === "strict",
    on_edit_format: profile !== "off",
    on_edit_lint: profile !== "off",
  };
}

/**
 * Apply profile defaults to a validated raw config. Explicit config keys
 * always override profile defaults.
 */
export function resolveConfig(raw: Config, configPath?: string): ResolvedConfig {
  const profile: Profile = raw.profile ?? (configPath ? "standard" : "off");
  const defaults = profileDefaults(profile);
  return {
    profile,
    configPath,
    commands: raw.commands ?? {},
    protect: raw.protect ?? DEFAULT_PROTECT,
    protect_mode: raw.protect_mode ?? defaults.protect_mode,
    protect_off: raw.protect_off ?? false,
    gate: {
      run_typecheck: raw.gate?.run_typecheck ?? true,
      run_tests: raw.gate?.run_tests ?? true,
      block_on_failure: raw.gate?.block_on_failure ?? defaults.block_on_failure,
      skip_unchanged: raw.gate?.skip_unchanged ?? true,
      scope: raw.gate?.scope ?? "all",
      lint_changed: raw.gate?.lint_changed ?? defaults.lint_changed,
      timeout: raw.gate?.timeout,
      max_blocks: raw.gate?.max_blocks ?? 3,
    },
    on_edit: {
      format: raw.on_edit?.format ?? defaults.on_edit_format,
      lint: raw.on_edit?.lint ?? defaults.on_edit_lint,
    },
    exclude: raw.exclude ?? [],
    constitution: raw.constitution,
    rules: Array.isArray(raw.rules) ? { mode: "replace", files: raw.rules } : raw.rules,
    style_guide: raw.style_guide,
  };
}

function validateConfig(data: unknown, configPath: string): Config {
  const result = configSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid configuration in ${configPath}:\n${issues}`);
  }
  return result.data;
}

const configCache = new Map<string, ResolvedConfig>();

/** Clear the per-session config cache (mainly for tests). */
export function clearConfigCache(): void {
  configCache.clear();
}

/**
 * Load and resolve the config for a project directory. Results are cached
 * per directory for the lifetime of the session.
 */
export function loadConfig(directory: string): ResolvedConfig {
  const cached = configCache.get(directory);
  if (cached) {
    return cached;
  }

  const configPath = findConfigFile(directory);
  let resolved: ResolvedConfig;
  if (!configPath) {
    resolved = resolveConfig({});
  } else {
    const parsed: unknown = parseYaml(readFileSync(configPath, "utf8"));
    const asRecord =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    const mapped = FALLBACK_FILES.has(basename(configPath)) ? mapFlatConfig(asRecord) : asRecord;
    resolved = resolveConfig(validateConfig(mapped, configPath), configPath);
  }

  configCache.set(directory, resolved);
  return resolved;
}
