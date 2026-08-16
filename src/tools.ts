import { join } from "node:path";
import { tool } from "@opencode-ai/plugin";
import { loadConfig, clearConfigCache } from "./config.js";
import { installTemplates, setProfileInFile, writeDetectedConfig } from "./installer.js";
import { getHookState, updateHookState } from "./registry.js";
import { loadConstitution } from "./rules.js";
import type { CommandMap, Profile, RulesConfig } from "./types.js";

const PROFILES: Profile[] = ["off", "advisory", "standard", "strict"];

function isProfile(value: string): value is Profile {
  return PROFILES.includes(value as Profile);
}

function formatCommandMap(map: CommandMap | undefined, indent: string): string {
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

function formatRules(rules: RulesConfig | undefined): string {
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

export function buildTools(_ctx: {
  directory: string;
}): NonNullable<import("@opencode-ai/plugin").Hooks["tool"]> {
  return {
    dev_framework_init: tool({
      description:
        "Scaffold opencode-dev-framework project files (agents, skills, commands, default config) into the current project. Missing files are created; existing files are skipped unless overwrite is true.",
      args: {
        directory: tool.schema
          .string()
          .optional()
          .describe("Target project directory (defaults to current project)"),
        overwrite: tool.schema
          .boolean()
          .optional()
          .describe("Overwrite existing files that differ from templates"),
      },
      async execute(args, context) {
        const targetDir = args.directory ?? context.directory;
        const result = await installTemplates(targetDir, {
          overwriteExisting: args.overwrite ?? false,
          skipExisting: !(args.overwrite ?? false),
        });
        const configResult = await writeDetectedConfig(targetDir, {
          overwriteExisting: args.overwrite ?? false,
          skipExisting: !(args.overwrite ?? false),
        });

        const lines = [
          `Installed opencode-dev-framework templates into ${targetDir}.`,
          `Created: ${result.created.length} file(s)`,
          `Overwritten: ${result.overwritten.length} file(s)`,
          `Skipped: ${result.skipped.length} file(s)`,
          `Config: ${configResult.action}`,
        ];
        if (result.created.length > 0) {
          lines.push("", "Created files:", ...result.created.map((file) => `- ${file}`));
        }
        if (result.overwritten.length > 0) {
          lines.push("", "Overwritten files:", ...result.overwritten.map((file) => `- ${file}`));
        }
        return lines.join("\n");
      },
    }),

    dev_framework_set_profile: tool({
      description:
        "Change the opencode-dev-framework profile (off, advisory, standard, strict) for the current project and apply it immediately without restarting OpenCode.",
      args: {
        profile: tool.schema.string().describe("New profile: off, advisory, standard, or strict"),
        directory: tool.schema
          .string()
          .optional()
          .describe("Project directory (defaults to current project)"),
      },
      async execute(args, context) {
        const targetDir = args.directory ?? context.directory;
        const profile = args.profile.trim().toLowerCase();

        if (!isProfile(profile)) {
          return `Invalid profile "${args.profile}". Valid values: ${PROFILES.join(", ")}.`;
        }

        const configPath = join(targetDir, ".opencode-dev-framework.yml");
        await setProfileInFile(configPath, profile);

        // Reload config and constitution so the change takes effect immediately.
        clearConfigCache();
        const config = loadConfig(targetDir);
        const { constitution } = await loadConstitution(config, targetDir);

        const state = getHookState(targetDir);
        if (state) {
          updateHookState(targetDir, { config, constitution });
        }

        return `opencode-dev-framework profile set to "${profile}" in ${configPath}. Change applied immediately.`;
      },
    }),

    dev_framework_status: tool({
      description:
        "Show the current opencode-dev-framework state for the project: active profile, guardrails, completion gate, on-edit behavior, tracked changed files, and block counts.",
      args: {
        directory: tool.schema
          .string()
          .optional()
          .describe("Project directory (defaults to current project)"),
      },
      async execute(args, context) {
        const targetDir = args.directory ?? context.directory;
        const state = getHookState(targetDir);
        const config = state?.config ?? loadConfig(targetDir);

        const lines: string[] = [];
        lines.push(`opencode-dev-framework status for ${targetDir}`);
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
        lines.push(`  typecheck:`);
        lines.push(formatCommandMap(config.commands.typecheck, "    "));
        lines.push(`  test:`);
        lines.push(formatCommandMap(config.commands.test, "    "));
        lines.push(`  test_changed:`);
        lines.push(
          config.commands.test_changed
            ? `    ${config.commands.test_changed}`
            : "    (not configured)",
        );
        lines.push(`  lint:`);
        lines.push(formatCommandMap(config.commands.lint, "    "));
        lines.push(`  format:`);
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
      },
    }),
  };
}
