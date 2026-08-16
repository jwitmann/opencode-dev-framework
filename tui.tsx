/** @jsxImportSource @opentui/solid */

import type { TuiPluginModule } from "@opencode-ai/plugin/tui";
import { loadConfig } from "./dist/config.js";
import { renderConfigStatus, renderHelp } from "./dist/format-status.js";
import { runCommand } from "./dist/host.js";
import { changeProfile, verifyGate } from "./dist/commands.js";
import { clearConfigCache } from "./dist/config.js";
import type { Profile } from "./dist/types.js";

type TuiApi = Parameters<TuiPluginModule["tui"]>[0];

type DevFrameworkCommand = {
  title: string;
  name: string;
  description: string;
  slashName: string;
  run: () => void | Promise<void>;
};

/**
 * Register dev-framework slash commands.
 *
 * The current OpenCode API is `api.keymap.registerLayer` (a command-palette
 * layer that also wires up `/slash` invocations). This mirrors how DCP
 * registers its commands. The legacy `api.command` v1 API is deprecated and
 * `undefined` in current runtimes, so it is intentionally not used.
 *
 * These are TUI commands, NOT prompt commands: their `run` handlers perform
 * the work directly and show a modal/toast. They never insert text into the
 * chat stream, so they cannot be re-processed as a user turn.
 */
function registerCommands(api: TuiApi, commands: DevFrameworkCommand[]): void {
  const keymap = (api as { keymap?: { registerLayer?: (layer: unknown) => void } }).keymap;
  if (!keymap?.registerLayer) {
    return;
  }
  keymap.registerLayer({
    commands: commands.map((command) => ({
      namespace: "palette",
      name: command.name,
      title: command.title,
      desc: command.description,
      category: "dev-framework",
      slashName: command.slashName,
      run: command.run,
    })),
  });
}

const PROFILES: Profile[] = ["off", "advisory", "standard", "strict"];

const tui: TuiPluginModule["tui"] = async (api) => {
  const directory = api.state.path.directory;

  const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") => {
    try {
      (
        api.ui as {
          toast?: (input: { title?: string; message: string; variant?: string }) => void;
        }
      ).toast?.({
        title: "opencode-dev-framework",
        message,
        variant,
      });
    } catch {
      // Toast may be unavailable; the dialog already shows the result.
    }
  };

  registerCommands(api, [
    {
      title: "dev-framework status",
      name: "df-status",
      description: "Show the current dev-framework configuration",
      slashName: "df-status",
      run: () => showStatusDialog(api, directory),
    },
    {
      title: "dev-framework help",
      name: "df-help",
      description: "List available dev-framework commands",
      slashName: "df-help",
      run: () => showHelpDialog(api),
    },
    {
      title: "dev-framework set profile",
      name: "df-profile",
      description: "Change the dev-framework profile (off, advisory, standard, strict)",
      slashName: "df-profile",
      run: () => showProfileDialog(api, directory, toast),
    },
    {
      title: "dev-framework verify",
      name: "df-verify",
      description: "Run the dev-framework completion gate manually",
      slashName: "df-verify",
      run: () => showVerifyDialog(api, directory, toast),
    },
  ]);
};

function showStatusDialog(api: TuiApi, directory: string): void {
  const config = loadConfig(directory);
  const DialogAlert = api.ui.DialogAlert;
  api.ui.dialog.replace(() => (
    <DialogAlert
      title="opencode-dev-framework status"
      message={renderConfigStatus(config)}
      onConfirm={() => api.ui.dialog.clear()}
    />
  ));
}

function showHelpDialog(api: TuiApi): void {
  const DialogAlert = api.ui.DialogAlert;
  api.ui.dialog.replace(() => (
    <DialogAlert
      title="dev-framework commands"
      message={renderHelp()}
      onConfirm={() => api.ui.dialog.clear()}
    />
  ));
}

function showProfileDialog(
  api: TuiApi,
  directory: string,
  toast: (message: string, variant?: "info" | "success" | "warning" | "error") => void,
): void {
  const DialogSelect = api.ui.DialogSelect;
  api.ui.dialog.replace(() => (
    <DialogSelect
      title="Set dev-framework profile"
      options={PROFILES.map((profile) => ({ title: profile, value: profile }))}
      onSelect={(option) => {
        void (async () => {
          const profile = option.value as Profile;
          await changeProfile(directory, profile);
          clearConfigCache();
          api.ui.dialog.clear();
          toast(
            `dev-framework profile set to "${profile}". Applies on the next tool call / gate run.`,
            "success",
          );
        })();
      }}
    />
  ));
}

async function showVerifyDialog(
  api: TuiApi,
  directory: string,
  toast: (message: string, variant?: "info" | "success" | "warning" | "error") => void,
): Promise<void> {
  const config = loadConfig(directory);
  const { report, summary } = await verifyGate(runCommand, directory, config);
  const DialogAlert = api.ui.DialogAlert;
  api.ui.dialog.replace(() => (
    <DialogAlert
      title="dev-framework completion gate"
      message={summary}
      onConfirm={() => api.ui.dialog.clear()}
    />
  ));
  toast(
    report.ok ? "Completion gate passed." : "Completion gate failed — see the report.",
    report.ok ? "success" : "error",
  );
}

export default {
  id: "opencode-dev-framework",
  tui,
} satisfies TuiPluginModule;
