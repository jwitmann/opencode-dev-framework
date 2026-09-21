/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode/plugin/tui";
import { changeProfile, verifyGate } from "./dist/commands.js";
import { loadConfig } from "./dist/config.js";
import { runCommand } from "./dist/host.js";
import { renderConfigStatus, renderHelp } from "./dist/format-status.js";
import type { Profile } from "./dist/types.js";

const PROFILES: Profile[] = ["off", "advisory", "standard", "strict"];

export default Plugin.define({
  id: "opencode-dev-framework",
  setup(ctx) {
    const getDirectory = (): string => {
      const loc = ctx.location as unknown as { directory?: string } | undefined;
      if (loc?.directory) return loc.directory;
      try {
        const def = (ctx.data as unknown as { location: { default: () => { directory: string } | undefined } }).location.default();
        if (def?.directory) return def.directory;
      } catch {
        // ignore
      }
      return process.cwd();
    };

    const register = () => {
      try {
        (ctx as unknown as { keymap?: { layer: (fn: () => unknown) => void } }).keymap?.layer?.(() => ({
          mode: "global",
          commands: [
            {
              id: "df-status",
              title: "dev-framework status",
              description: "Show the current dev-framework configuration",
              group: "dev-framework",
              palette: true,
              slash: { name: "df-status" },
              run: () => {
                const dir = getDirectory();
                const config = loadConfig(dir);
                void ctx.ui.dialog.alert({
                  title: "opencode-dev-framework status",
                  message: renderConfigStatus(config),
                });
              },
            },
            {
              id: "df-help",
              title: "dev-framework help",
              description: "List available dev-framework commands",
              slash: { name: "df-help" },
              group: "dev-framework",
              palette: true,
              run: () => {
                void ctx.ui.dialog.alert({
                  title: "dev-framework commands",
                  message: renderHelp(),
                });
              },
            },
            {
              id: "df-profile",
              title: "dev-framework profile",
              description: "Change the active dev-framework profile",
              group: "dev-framework",
              palette: true,
              slash: { name: "df-profile", arguments: true },
              run: async (input?: string) => {
                const dir = getDirectory();
                const raw = (input ?? "").trim();
                const arg = raw === "df-profile" ? "" : raw;
                if (arg && (PROFILES as string[]).includes(arg)) {
                  const message = await changeProfile(dir, arg as Profile);
                  ctx.ui.toast.show({ message, variant: "success" });
                  return;
                }
                if (arg) {
                  ctx.ui.toast.show({
                    message: `Usage: /df-profile <${PROFILES.join("|")}>`,
                    variant: "warning",
                  });
                  return;
                }
                const selected = await ctx.ui.dialog.select({
                  title: "dev-framework profile",
                  options: PROFILES.map((p) => ({ title: p, value: p })),
                });
                if (selected) {
                  const message = await changeProfile(dir, selected as Profile);
                  ctx.ui.toast.show({ message, variant: "success" });
                }
              },
            },
            {
              id: "df-verify",
              title: "dev-framework verify",
              description: "Run the dev-framework completion gate",
              group: "dev-framework",
              palette: true,
              slash: { name: "df-verify" },
              run: async () => {
                const dir = getDirectory();
                const config = loadConfig(dir);
                const { summary, report } = await verifyGate(runCommand, dir, config);
                await ctx.ui.dialog.alert({
                  title: report.ok ? "dev-framework gate passed" : "dev-framework gate failed",
                  message: summary,
                });
                ctx.ui.toast.show({ message: summary, variant: report.ok ? "success" : "error" });
              },
            },
          ],
        }));
      } catch (e) {
        try {
          console.warn("[opencode-dev-framework:tui] keymap registration failed:", String(e));
        } catch {}
      }
    };

    try {
      const slot = (ctx.ui as unknown as { slot?: (claim: { append: string; render: () => unknown }) => void }).slot;
      if (typeof slot === "function") {
        slot({
          append: "app",
          render() {
            register();
            return null as unknown as null;
          },
        });
        return;
      }
    } catch {
      // ignore, fallback below
    }

    register();
  },
});
