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
      dialog: {
        replace: () => {},
        clear: () => {},
      },
    },
    ...overrides,
  } as unknown as TuiApi;
}

describe("TUI plugin module", () => {
  it("registers /df-status and /df-help via api.keymap.registerLayer", async () => {
    const layers: Array<{ commands: Array<{ name: string; slashName: string; run: unknown }> }> =
      [];
    const api = makeApi({
      keymap: {
        registerLayer: (layer: unknown) => layers.push(layer as never),
      } as never,
    });

    await tuiModule.tui(api, undefined, { id: "test" } as never);

    expect(layers).toHaveLength(1);
    const commands = layers[0].commands;
    expect(commands).toHaveLength(2);
    expect(commands[0].name).toBe("df-status");
    expect(commands[0].slashName).toBe("df-status");
    expect(commands[0].run).toBeTypeOf("function");
    expect(commands[1].name).toBe("df-help");
    expect(commands[1].slashName).toBe("df-help");
  });

  it("registers nothing (and does not throw) when keymap is unavailable", async () => {
    // The legacy `api.command` v1 API is deprecated and `undefined` in current
    // runtimes, so registration is a no-op when `api.keymap` is missing.
    const api = makeApi({
      command: {
        register: () => {
          throw new Error("legacy api.command should not be used");
        },
      } as never,
    });

    await expect(tuiModule.tui(api, undefined, { id: "test" } as never)).resolves.toBeUndefined();
  });

  it("opens a status dialog when the /df-status command runs", async () => {
    const replaceCalls: Array<() => unknown> = [];
    let runStatus: (() => void) | undefined;

    const api = makeApi({
      keymap: {
        registerLayer: (layer: unknown) => {
          const commands = (layer as { commands: Array<{ name: string; run: () => void }> })
            .commands;
          runStatus = commands.find((c) => c.name === "df-status")?.run;
        },
      } as never,
      ui: {
        DialogAlert: ((props: { title: string; message: string; onConfirm?: () => void }) =>
          props) as unknown as TuiApi["ui"]["DialogAlert"],
        dialog: {
          replace: (render: () => unknown) => {
            replaceCalls.push(render);
          },
          clear: () => {},
        },
      },
    });

    await tuiModule.tui(api, undefined, { id: "test" } as never);
    runStatus?.();

    expect(replaceCalls).toHaveLength(1);
  });
});
