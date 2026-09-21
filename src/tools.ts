/**
 * Legacy tool definitions for test helpers. Production tools are now
 * registered via ctx.tool.transform in src/index.ts (V2). This file is kept
 * for the buildHooks test adapter and does not depend on @opencode-ai/plugin.
 */

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

export interface ToolDef {
  description: string;
  args?: Record<string, unknown>;
  execute: (args: Record<string, unknown>, context: { directory: string }) => Promise<string>;
}

export function buildTools(_ctx: { directory: string }): Record<string, ToolDef> {
  return {
    dev_framework_init: {
      description:
        "Scaffold opencode-dev-framework project files (agents, skills, commands, default config) into the current project. Missing files are created; existing files are skipped unless overwrite is true.",
      args: {
        directory: {
          type: "string",
          description: "Target project directory (defaults to current project)",
        },
        overwrite: {
          type: "boolean",
          description: "Overwrite existing files that differ from templates",
        },
      },
      async execute(args, context) {
        const targetDir = (args.directory as string | undefined) ?? context.directory;
        const result = await installTemplates(targetDir, {
          overwriteExisting: (args.overwrite as boolean | undefined) ?? false,
          skipExisting: !((args.overwrite as boolean | undefined) ?? false),
        });
        const configResult = await writeDetectedConfig(targetDir, {
          overwriteExisting: (args.overwrite as boolean | undefined) ?? false,
          skipExisting: !((args.overwrite as boolean | undefined) ?? false),
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
    },

    dev_framework_set_profile: {
      description:
        "Change the opencode-dev-framework profile (off, advisory, standard, strict) for the current project and apply it immediately without restarting OpenCode.",
      args: {
        profile: { type: "string", description: "New profile: off, advisory, standard, or strict" },
        directory: {
          type: "string",
          description: "Project directory (defaults to current project)",
        },
      },
      async execute(args, context) {
        const targetDir = (args.directory as string | undefined) ?? context.directory;
        const raw = String(args.profile ?? "");
        const profile = raw.trim().toLowerCase();

        if (!isProfile(profile)) {
          return `Invalid profile "${raw}". Valid values: ${PROFILES.join(", ")}.`;
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
    },

    dev_framework_status: {
      description:
        "Show the current opencode-dev-framework state for the project: active profile, guardrails, completion gate, on-edit behavior, tracked changed files, and block counts.",
      args: {
        directory: {
          type: "string",
          description: "Project directory (defaults to current project)",
        },
      },
      async execute(args, context) {
        const targetDir = (args.directory as string | undefined) ?? context.directory;
        const state = getHookState(targetDir);
        const config = state?.config ?? loadConfig(targetDir);
        return renderStatus(config, state as unknown as Parameters<typeof renderStatus>[1]);
      },
    },
  };
}
