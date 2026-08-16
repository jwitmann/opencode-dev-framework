import { describe, expect, it } from "vitest";
import type { TuiPluginModule } from "@opencode-ai/plugin/tui";
import tuiModule from "../tui.tsx";

type TuiApi = Parameters<TuiPluginModule["tui"]>[0];

function makeApi(overrides: Partial<TuiApi> = {}): TuiApi {
  return {
    state: { path: { directory: "/project" } },
    ui: {
      DialogAlert: ((props: { title: string; message: string; onConfirm?: () => void }) =>
        props) as unknown as TuiApi["ui"]["DialogAlert"],
      DialogSelect: ((props: { title: string; options: unknown[]; onSelect?: () => void }) =>
        props) as unknown as TuiApi["ui"]["DialogSelect"],
      dialog: {
        replace: () => {},
        clear: () => {},
      },
    },
    ...overrides,
  } as unknown as TuiApi;
}

async function registeredCommands(api: TuiApi) {
  const layers: Array<{ commands: Array<{ name: string; slashName: string; run: () => void }> }> =
    [];
  const withLayer = makeApi({
    ...api,
    keymap: {
      registerLayer: (layer: unknown) => layers.push(layer as never),
    } as never,
  });
  await tuiModule.tui(withLayer, undefined, { id: "test" } as never);
  return layers[0]?.commands ?? [];
}

describe("TUI plugin module", () => {
  it("registers all four /df-* commands via keymap.registerLayer with slashName", async () => {
    const commands = await registeredCommands(makeApi());
    expect(commands).toHaveLength(4);
    const names = commands.map((c) => c.name).sort();
    expect(names).toEqual(["df-help", "df-profile", "df-status", "df-verify"]);
    for (const command of commands) {
      expect(command.slashName).toBe(command.name);
      expect(command.run).toBeTypeOf("function");
    }
  });

  it("falls back to the legacy api.command registration when keymap is unavailable", async () => {
    let registered: unknown = null;
    const api = makeApi({
      command: {
        register: (fn: () => unknown) => {
          registered = fn();
        },
      } as never,
    });
    await expect(tuiModule.tui(api, undefined, { id: "test" } as never)).resolves.toBeUndefined();
    expect(registered).not.toBeNull();
    expect(Array.isArray(registered)).toBe(true);
    expect((registered as Array<{ slash?: { name: string } }>).length).toBe(4);
  });

  it("is a no-op (and does not throw) when neither keymap nor api.command is available", async () => {
    const api = makeApi({ command: undefined });
    await expect(tuiModule.tui(api, undefined, { id: "test" } as never)).resolves.toBeUndefined();
  });

  it("opens a status dialog when /df-status runs", async () => {
    const replaceCalls: Array<() => unknown> = [];
    const commands = await registeredCommands(
      makeApi({
        ui: {
          DialogAlert: ((props: { title: string; message: string; onConfirm?: () => void }) =>
            props) as unknown as TuiApi["ui"]["DialogAlert"],
          DialogSelect: ((props: { title: string; options: unknown[]; onSelect?: () => void }) =>
            props) as unknown as TuiApi["ui"]["DialogSelect"],
          dialog: {
            replace: (render: () => unknown) => {
              replaceCalls.push(render);
            },
            clear: () => {},
          },
        },
      }),
    );
    const runStatus = commands.find((c) => c.name === "df-status")?.run;
    runStatus?.();
    expect(replaceCalls).toHaveLength(1);
  });

  it("opens a profile picker when /df-profile runs without an argument", async () => {
    const replaceCalls: Array<() => unknown> = [];
    const commands = await registeredCommands(
      makeApi({
        ui: {
          DialogAlert: ((props: { title: string; message: string; onConfirm?: () => void }) =>
            props) as unknown as TuiApi["ui"]["DialogAlert"],
          DialogSelect: ((props: { title: string; options: unknown[]; onSelect?: () => void }) =>
            props) as unknown as TuiApi["ui"]["DialogSelect"],
          dialog: {
            replace: (render: () => unknown) => {
              replaceCalls.push(render);
            },
            clear: () => {},
          },
        },
      }),
    );
    const runProfile = commands.find((c) => c.name === "df-profile")?.run;
    runProfile?.();
    expect(replaceCalls).toHaveLength(1);
    const rendered = replaceCalls[0]?.() as { title: string; options: unknown[] };
    expect(rendered.title).toContain("profile");
    expect(rendered.options).toHaveLength(4);
  });
});
