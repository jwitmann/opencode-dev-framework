/**
 * Shared types for opencode-dev-framework.
 *
 * The config vocabulary follows docs/plans/03-config-spec.md.
 */

export type Profile = "off" | "advisory" | "standard" | "strict";

export type ProtectMode = "warn" | "deny";

export type GateScope = "all" | "changed";

/**
 * A command specification: either a single default command string, or a map
 * of per-extension overrides keyed by extension (e.g. `.go`).
 */
export type CommandMap = string | Record<string, string>;

export interface CommandsConfig {
  test?: string;
  typecheck?: string;
  format?: CommandMap;
  lint?: CommandMap;
  test_changed?: string;
}

export interface GateConfig {
  run_typecheck: boolean;
  run_tests: boolean;
  /**
   * If true, gate failures are reported loudly. Note: OpenCode cannot
   * physically block session completion, so this is advisory by nature.
   */
  block_on_failure: boolean;
  skip_unchanged: boolean;
  scope: GateScope;
  lint_changed: boolean;
  /** Per-command timeout in seconds. */
  timeout?: number;
  /** Reserved for future use; advisory mode currently ignores this. */
  max_blocks: number;
}

export interface OnEditConfig {
  format: boolean;
  lint: boolean;
}

/**
 * Raw config as parsed from a config file. Every field is optional; defaults
 * are applied during resolution (see resolveConfig in config.ts).
 */
export interface Config {
  profile?: Profile;
  commands?: CommandsConfig;
  protect?: string[];
  protect_mode?: ProtectMode;
  protect_off?: boolean;
  gate?: Partial<GateConfig>;
  on_edit?: Partial<OnEditConfig>;
  exclude?: string[];
  /** Path to a custom constitution file (absolute or relative to project root). */
  constitution?: string;
  rules?: string[];
  style_guide?: string;
}

/**
 * Fully resolved config with profile defaults applied. All consumers of the
 * config should use this type, never the raw Config.
 */
export interface ResolvedConfig {
  profile: Profile;
  /** Absolute path of the config file that was loaded, if any. */
  configPath?: string;
  commands: CommandsConfig;
  protect: string[];
  protect_mode: ProtectMode;
  protect_off: boolean;
  gate: GateConfig;
  on_edit: OnEditConfig;
  exclude: string[];
  constitution?: string;
  rules?: string[];
  style_guide?: string;
}
