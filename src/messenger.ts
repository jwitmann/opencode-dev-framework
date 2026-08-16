import type { PluginInput } from "@opencode-ai/plugin";

export type SendMessageFn = (sessionID: string, text: string) => Promise<void>;

/**
 * Create a messenger that posts a chat message without it being treated as a
 * user turn.
 *
 * DCP's approach (and the OpenCode SDK shape) is to call
 * `client.session.prompt` with a `{ path: { id: sessionID }, body: {...} }`
 * wrapper and a text part marked `ignored: true`. This shows the message in the
 * conversation UI but does not feed it back to the model as input.
 *
 * If the prompt API fails or is unavailable, the messenger falls back to a TUI
 * toast so the output is still visible.
 */
export function createMessenger(client: PluginInput["client"]): SendMessageFn {
  const typedClient = client as unknown as {
    session?: { prompt?: (input: unknown) => Promise<unknown> };
    tui?: { showToast?: (input: unknown) => Promise<unknown> };
  };
  const prompt = typedClient?.session?.prompt;
  const showToast = typedClient?.tui?.showToast;

  return async (sessionID, text) => {
    if (prompt) {
      try {
        await prompt({
          path: { id: sessionID },
          body: {
            noReply: true,
            parts: [
              {
                type: "text",
                text,
                ignored: true,
              },
            ],
          },
        });
        return;
      } catch {
        // Fall through to toast so the message is still surfaced.
      }
    }

    if (showToast) {
      try {
        await showToast({
          title: "opencode-dev-framework",
          message: text,
          variant: "info",
        });
      } catch {
        // Nothing else to do.
      }
    }
  };
}
