import { describe, expect, it } from "vitest";
import { createMessenger } from "../src/messenger";

describe("createMessenger", () => {
  it("calls client.session.prompt with the SDK v2 shape and ignored: true", async () => {
    const calls: unknown[] = [];
    const client = {
      session: {
        prompt: async (input: unknown) => {
          calls.push(input);
        },
      },
    };

    const send = createMessenger(client as unknown as Parameters<typeof createMessenger>[0]);
    await send("ses_123", "hello from df-status");

    expect(calls).toHaveLength(1);
    const call = calls[0] as {
      path: { sessionID: string };
      body: { noReply: boolean; parts: Array<{ type: string; text: string; ignored?: boolean }> };
    };
    expect(call.path.sessionID).toBe("ses_123");
    expect(call.body.noReply).toBe(true);
    expect(call.body.parts).toHaveLength(1);
    expect(call.body.parts[0].type).toBe("text");
    expect(call.body.parts[0].text).toBe("hello from df-status");
    expect(call.body.parts[0].ignored).toBe(true);
  });

  it("falls back to client.tui.showToast when session.prompt is unavailable", async () => {
    const toastCalls: unknown[] = [];
    const client = {
      session: {},
      tui: {
        showToast: async (input: unknown) => {
          toastCalls.push(input);
        },
      },
    };

    const send = createMessenger(client as unknown as Parameters<typeof createMessenger>[0]);
    await send("ses_123", "toast message");

    expect(toastCalls).toHaveLength(1);
    const toast = toastCalls[0] as { title?: string; message: string; variant?: string };
    expect(toast.message).toBe("toast message");
    expect(toast.variant).toBe("info");
  });

  it("falls back to toast when session.prompt throws", async () => {
    const toastCalls: unknown[] = [];
    const client = {
      session: {
        prompt: async () => {
          throw new Error("prompt failed");
        },
      },
      tui: {
        showToast: async (input: unknown) => {
          toastCalls.push(input);
        },
      },
    };

    const send = createMessenger(client as unknown as Parameters<typeof createMessenger>[0]);
    await send("ses_123", "fallback toast");

    expect(toastCalls).toHaveLength(1);
    expect((toastCalls[0] as { message: string }).message).toBe("fallback toast");
  });
});
