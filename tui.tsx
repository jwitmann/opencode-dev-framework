/** @jsxImportSource @opentui/solid */

import type { TuiPluginModule } from "@opencode-ai/plugin/tui";
import { changeProfile, verifyGate } from "./dist/commands.js";
import { loadConfig } from "./dist/config.js";
import { runCommand } from "./dist/host.js";
import { renderConfigStatus, renderHelp } from "./dist/format-status.js";
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
 * The `slashName` field is what makes OpenCode recognize the command **with
 * arguments** (e.g. `/df-profile standard`) and route the trailing text to the
 * server `command.execute.before` hook. The `run` callback handles the
 * no-argument case (e.g. `/df-profile` opens a picker).
 *
 * `/df-status` and `/df-help` render in a modal. `/df-profile` opens a picker
 * and `/df-verify` runs the gate directly when invoked with no argument; when
 * an argument is supplied, the server `command.execute.before` hook handles it
 * and clears `output.parts` so the argument is never echoed to the model.
 */
function registerCommands(api: TuiApi, commands: DevFrameworkCommand[]): void {
  const keymap = (api as { keymap?: { registerLayer?: (layer: unknown) => void } }).keymap;
  if (keymap?.registerLayer) {
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
    return;
  }

  // Legacy v1 API fallback (used on runtimes where keymap.registerLayer is
  // unavailable). Mirrors how DCP registers its commands.
  const commandApi = (api as { command?: { register?: (fn: () => unknown) => void } }).command;
  commandApi?.register?.(() =>
    commands.map((command) => ({
      title: command.title,
      value: command.name,
      description: command.description,
      category: "dev-framework",
      slash: { name: command.slashName },
      onSelect: command.run,
    })),
  );
}

const PROFILES: Profile[] = ["off", "advisory", "standard", "strict"];

const tui: TuiPluginModule["tui"] = async (api) => {
  const directory = api.state.path.directory;

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
      title: "dev-framework profile",
      name: "df-profile",
      description: "Change the active dev-framework profile",
      slashName: "df-profile",
      run: () => showProfileDialog(api, directory),
    },
    {
      title: "dev-framework verify",
      name: "df-verify",
      description: "Run the dev-framework completion gate",
      slashName: "df-verify",
      run: () => showVerifyDialog(api, directory),
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

function showProfileDialog(api: TuiApi, directory: string): void {
  const DialogSelect = api.ui.DialogSelect;
  api.ui.dialog.replace(() => (
    <DialogSelect
      title="dev-framework profile"
      options={PROFILES.map((p) => ({ title: p, value: p }))}
      onSelect={(option) => {
        api.ui.dialog.clear();
        void changeProfile(directory, option.value as Profile).then((message) => {
          api.ui.toast?.({ message, variant: "success" });
        });
      }}
    />
  ));
}

async function showVerifyDialog(api: TuiApi, directory: string): Promise<void> {
  const config = loadConfig(directory);
  const { summary, report } = await verifyGate(runCommand, directory, config);
  const DialogAlert = api.ui.DialogAlert;
  api.ui.dialog.replace(() => (
    <DialogAlert
      title={report.ok ? "dev-framework gate passed" : "dev-framework gate failed"}
      message={summary}
      onConfirm={() => api.ui.dialog.clear()}
    />
  ));
  api.ui.toast?.({ message: summary, variant: report.ok ? "success" : "error" });
}

export default {
  id: "opencode-dev-framework",
  tui,
} satisfies TuiPluginModule;
