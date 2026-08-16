import type { HookState } from "./registry.js";
import type { ResolvedConfig } from "./types.js";

function formatCommandMap(
  map: ResolvedConfig["commands"]["lint"] | undefined,
  indent: string,
): string {
  if (map === undefined) {
    return `${indent}(not configured)`;
  }
  if (typeof map === "string") {
    return `${indent}${map}`;
  }
  const entries = Object.entries(map);
  if (entries.length === 0) {
    return `${indent}(not configured)`;
  }
  return entries.map(([ext, cmd]) => `${indent}${ext}: ${cmd}`).join("\n");
}

function formatRules(rules: ResolvedConfig["rules"] | undefined): string {
  if (rules === undefined) {
    return "  (bundled rules)";
  }
  const lines = [`  mode: ${rules.mode}`];
  if (rules.files.length === 0) {
    lines.push("  files: (none)");
  } else {
    lines.push("  files:");
    for (const file of rules.files) {
      lines.push(`    - ${file}`);
    }
  }
  return lines.join("\n");
}

/**
 * Render a human-readable summary of the current plugin state.
 *
 * Used by the `dev_framework_status` custom tool and by the `/df-status`
 * slash-command handler.
 */
export function renderStatus(config: ResolvedConfig, state?: HookState | null): string {
  const lines: string[] = [];
  lines.push(`opencode-dev-framework status`);
  lines.push("");
  lines.push(`Profile: ${config.profile}`);
  lines.push(`Config: ${config.configPath ?? "(none — defaults to off)"}`);
  lines.push("");
  lines.push("Guardrails:");
  lines.push(`  protect_mode: ${config.protect_mode}`);
  lines.push(`  protect_off: ${config.protect_off}`);
  if (config.protect.length === 0) {
    lines.push("  protected paths: (none)");
  } else {
    lines.push("  protected paths:");
    for (const pattern of config.protect) {
      lines.push(`    - ${pattern}`);
    }
  }
  lines.push("");
  lines.push("On edit:");
  lines.push(`  format: ${config.on_edit.format}`);
  lines.push(`  lint: ${config.on_edit.lint}`);
  lines.push(`  precommit: ${config.precommit}`);
  if (state && config.precommit === "auto") {
    lines.push(
      `  pre-commit binary available: ${state.precommitAvailable === true ? "yes" : state.precommitAvailable === false ? "no" : "not checked yet"}`,
    );
  }
  lines.push("");
  lines.push("Completion gate:");
  lines.push(`  run_typecheck: ${config.gate.run_typecheck}`);
  lines.push(`  run_tests: ${config.gate.run_tests}`);
  lines.push(`  lint_changed: ${config.gate.lint_changed}`);
  lines.push(`  block_on_failure: ${config.gate.block_on_failure}`);
  lines.push(`  skip_unchanged: ${config.gate.skip_unchanged}`);
  lines.push(`  scope: ${config.gate.scope}`);
  lines.push(`  timeout: ${config.gate.timeout ?? "(default)"}`);
  lines.push(`  max_blocks: ${config.gate.max_blocks}`);
  lines.push("");
  lines.push("Commands:");
  lines.push("  typecheck:");
  lines.push(formatCommandMap(config.commands.typecheck, "    "));
  lines.push("  test:");
  lines.push(formatCommandMap(config.commands.test, "    "));
  lines.push("  test_changed:");
  lines.push(
    config.commands.test_changed ? `    ${config.commands.test_changed}` : "    (not configured)",
  );
  lines.push("  lint:");
  lines.push(formatCommandMap(config.commands.lint, "    "));
  lines.push("  format:");
  lines.push(formatCommandMap(config.commands.format, "    "));
  lines.push("");
  lines.push("Constitution rules:");
  lines.push(formatRules(config.rules));
  if (config.style_guide) {
    lines.push(`  style_guide: ${config.style_guide}`);
  }

  if (state) {
    const changedFiles = state.tracker.getChangedFiles();
    lines.push("");
    lines.push(`Changed files tracked: ${changedFiles.length}`);
    if (changedFiles.length > 0) {
      for (const file of changedFiles) {
        lines.push(`  - ${file}`);
      }
    }

    if (state.blockCounts.size > 0) {
      lines.push("");
      lines.push("Completion gate blocks this session:");
      for (const [sessionID, count] of state.blockCounts) {
        lines.push(`  ${sessionID}: ${count}/${config.gate.max_blocks}`);
      }
    }
  }

  return lines.join("\n");
}
