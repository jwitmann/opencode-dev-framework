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
 * Register dev-framework slash commands that are best shown as a modal.
 *
 * The current OpenCode API is `api.keymap.registerLayer` (a command-palette
 * layer that also wires up `/slash` invocations). This mirrors how DCP
 * registers its commands. The legacy `api.command` v1 API is deprecated and
 * `undefined` in current runtimes, so it is intentionally not used.
 *
 * Only `/df-status` and `/df-help` live here. These take no arguments and
 * render in a modal, so they never insert text into the chat stream. The
 * argument-bearing commands `/df-profile` and `/df-verify` are registered as
 * server-side *prompt* commands (see `config` hook in index.ts) so that
 * OpenCode routes `/df-profile standard` to `command.execute.before` with the
 * argument, where the handler clears `output.parts` to keep the argument out
 * of the model context.
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
