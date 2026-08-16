import { describe, expect, it } from "vitest";
import type { TuiPluginModule } from "@opencode-ai/plugin/tui";
import tuiModule from "../tui.tsx";

describe("TUI plugin module", () => {
  it("registers /df-status and /df-help slash commands", async () => {
    const registered: Array<{
      title: string;
      value: string;
      slash?: { name: string };
      onSelect?: () => void;
    }> = [];

    const api = {
      state: {
        path: { directory: "/project" },
      },
      command: {
        register: (factory: () => typeof registered) => {
          registered.push(...factory());
        },
      },
      ui: {
        DialogAlert: ((props: { title: string; message: string; onConfirm?: () => void }) =>
          props) as unknown as Parameters<TuiPluginModule["tui"]>[0]["ui"]["DialogAlert"],
        dialog: {
          replace: () => {},
          clear: () => {},
        },
      },
    } as unknown as Parameters<TuiPluginModule["tui"]>[0];

    await tuiModule.tui(api, undefined, { id: "test" } as never);

    expect(registered).toHaveLength(2);
    expect(registered[0].value).toBe("df-status");
    expect(registered[0].slash?.name).toBe("df-status");
    expect(registered[1].value).toBe("df-help");
    expect(registered[1].slash?.name).toBe("df-help");
  });

  it("opens a dialog when /df-status onSelect runs", async () => {
    const replaceCalls: Array<() => unknown> = [];
    let selected: (() => void) | undefined;

    const api = {
      state: {
        path: { directory: "/project" },
      },
      command: {
        register: (factory: () => Array<{ onSelect?: () => void }>) => {
          const commands = factory();
          selected = commands.find((c) => "onSelect" in c)?.onSelect;
        },
      },
      ui: {
        DialogAlert: ((props: { title: string; message: string; onConfirm?: () => void }) =>
          props) as unknown as Parameters<TuiPluginModule["tui"]>[0]["ui"]["DialogAlert"],
        dialog: {
          replace: (render: () => unknown) => {
            replaceCalls.push(render);
          },
          clear: () => {},
        },
      },
    } as unknown as Parameters<TuiPluginModule["tui"]>[0];

    await tuiModule.tui(api, undefined, { id: "test" } as never);
    selected?.();

    expect(replaceCalls).toHaveLength(1);
  });
});
