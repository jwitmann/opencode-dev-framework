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
  it("registers df-status and df-help as TUI modal commands via keymap", async () => {
    const commands = await registeredCommands(makeApi());
    expect(commands).toHaveLength(2);
    const names = commands.map((c) => c.name).sort();
    expect(names).toEqual(["df-help", "df-status"]);
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
    expect((registered as Array<{ slash?: { name: string } }>).length).toBe(2);
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

  it("does not register df-profile or df-verify as TUI commands", async () => {
    const commands = await registeredCommands(makeApi());
    expect(commands.find((c) => c.name === "df-profile")).toBeUndefined();
    expect(commands.find((c) => c.name === "df-verify")).toBeUndefined();
  });
});
