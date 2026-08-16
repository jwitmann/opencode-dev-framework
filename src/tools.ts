import { tool } from "@opencode-ai/plugin";
import { loadConfig, clearConfigCache } from "./config.js";
import { installTemplates, writeDetectedConfig } from "./installer.js";
import { getHookState, updateHookState } from "./registry.js";
import { loadConstitution } from "./rules.js";
import { renderStatus } from "./format-status.js";
import { changeProfile } from "./commands.js";
import type { Profile } from "./types.js";

const PROFILES: Profile[] = ["off", "advisory", "standard", "strict"];

function isProfile(value: string): value is Profile {
  return PROFILES.includes(value as Profile);
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

        const message = await changeProfile(targetDir, profile);

        // Reload config and constitution so the change takes effect immediately.
        clearConfigCache();
        const config = loadConfig(targetDir);
        const { constitution } = await loadConstitution(config, targetDir);

        const state = getHookState(targetDir);
        if (state) {
          updateHookState(targetDir, { config, constitution });
        }

        return `${message} Change applied immediately.`;
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
        return renderStatus(config, state);
      },
    }),
  };
}
