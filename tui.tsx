/** @jsxImportSource @opentui/solid */

import type { TuiPluginModule } from "@opencode-ai/plugin/tui";
import { loadConfig } from "./dist/config.js";
import { renderConfigStatus, renderHelp } from "./dist/format-status.js";

const tui: TuiPluginModule["tui"] = async (api) => {
  const directory = api.state.path.directory;
  const commandApi = api.command;

  if (!commandApi) {
    return;
  }

  commandApi.register(() => [
    {
      title: "dev-framework status",
      value: "df-status",
      description: "Show the current dev-framework configuration",
      category: "dev-framework",
      slash: { name: "df-status" },
      onSelect: () => {
        showStatusDialog(api, directory);
      },
    },
    {
      title: "dev-framework help",
      value: "df-help",
      description: "List available dev-framework commands",
      category: "dev-framework",
      slash: { name: "df-help" },
      onSelect: () => {
        showHelpDialog(api);
      },
    },
  ]);
};

function showStatusDialog(
  api: Parameters<TuiPluginModule["tui"]>[0],
  directory: string,
): void {
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

function showHelpDialog(api: Parameters<TuiPluginModule["tui"]>[0]): void {
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
