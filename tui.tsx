/** @jsxImportSource @opentui/solid */

import type { TuiPluginModule } from "@opencode-ai/plugin/tui";
import { changeProfile, verifyGate } from "./dist/commands.js";
import { loadConfig } from "./dist/config.js";
import { runCommand } from "./dist/host.js";
import { renderConfigStatus, renderHelp } from "./dist/format-status.js";
import type { Profile } from "./dist/types.js";

type TuiApi = Parameters<TuiPluginModule["tui"]>[0];

/**
 * OpenCode invokes a slash command's `run` with a keymap `CommandContext`.
 * The trailing slash text (e.g. `standard` in `/df-profile standard`) is
 * available on `ctx.input`. TUI commands are UI-only: they never insert text
 * into the chat stream, so they cannot leak into a model turn.
 */
type CommandCtx = { input?: string };

type DevFrameworkCommand = {
  title: string;
  name: string;
  description: string;
  slashName: string;
  run: (ctx?: CommandCtx) => void | Promise<void>;
};

/**
 * Register dev-framework slash commands.
 *
 * The current OpenCode API is `api.keymap.registerLayer` (a command-palette
 * layer that also wires up `/slash` invocations). This mirrors how DCP
 * registers its commands. The legacy `api.command` v1 API is kept as a
 * fallback (also like DCP). `slashName` makes OpenCode recognize the command
 * **with arguments** and pass the trailing text to `run` via `ctx.input`.
 *
 * All four commands are TUI commands (no server prompt command, which would
 * produce a model turn). Each `run` reads `ctx.input` so both the bare form
 * (e.g. `/df-profile` opens a picker) and the argument form (e.g.
 * `/df-profile standard` applies directly) work without feeding text to the
 * model.
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
      run: (ctx) => handleProfile(api, directory, ctx?.input),
    },
    {
      title: "dev-framework verify",
      name: "df-verify",
      description: "Run the dev-framework completion gate",
      slashName: "df-verify",
      run: () => handleVerify(api, directory),
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

/** Bare `/df-profile` opens a picker; `/df-profile <name>` applies directly. */
function handleProfile(api: TuiApi, directory: string, input?: string): void {
  const arg = (input ?? "").trim();
  if (arg && PROFILES.includes(arg as Profile)) {
    void changeProfile(directory, arg as Profile).then((message) => {
      api.ui.toast?.({ message, variant: "success" });
    });
    api.ui.dialog.clear();
    return;
  }
  if (arg) {
    api.ui.toast?.({
      message: `Usage: /df-profile <${PROFILES.join("|")}>`,
      variant: "warning",
    });
    api.ui.dialog.clear();
    return;
  }
  showProfileDialog(api, directory);
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

async function handleVerify(api: TuiApi, directory: string): Promise<void> {
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
