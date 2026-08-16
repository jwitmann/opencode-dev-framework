/** @jsxImportSource @opentui/solid */

import type { TuiPluginModule } from "@opencode-ai/plugin/tui";
import { loadConfig } from "./dist/config.js";
import { renderConfigStatus, renderHelp } from "./dist/format-status.js";

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
 * registers its commands. The legacy `api.command` v1 API is kept as a
 * fallback (also like DCP). `slashName` makes OpenCode recognize the command.
 *
 * Only `df-status` and `df-help` are TUI modals. `df-profile` and `df-verify`
 * are registered as server prompt commands (in `src/index.ts`) so they fire
 * `command.execute.before` with arguments and never reach the model.
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

export default {
  id: "opencode-dev-framework",
  tui,
} satisfies TuiPluginModule;
