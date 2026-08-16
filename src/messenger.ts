import type { PluginInput } from "@opencode-ai/plugin";

export type SendMessageFn = (sessionID: string, text: string) => Promise<void>;

/**
 * Create a messenger that posts a chat message without it being treated as a
 * user turn.
 *
 * OpenCode SDK v2 expects `client.session.prompt` to be called with:
 *
 * ```
 * {
 *   path: { sessionID: string },
 *   body: {
 *     noReply: true,
 *     parts: [{ type: "text", text: string, ignored: true }],
 *   },
 * }
 * ```
 *
 * The `ignored: true` flag keeps the message visible in the conversation UI
 * while preventing it from being fed back to the model as input.
 *
 * If the prompt API fails or is unavailable, the messenger falls back to a TUI
 * toast so the output is still visible.
 */
export function createMessenger(client: PluginInput["client"]): SendMessageFn {
  const typedClient = client as unknown as {
    session?: { prompt?: (input: unknown) => Promise<unknown> };
    tui?: {
      showToast?: (input: {
        title?: string;
        message: string;
        variant?: string;
        duration?: number;
      }) => Promise<unknown>;
    };
  };
  const prompt = typedClient?.session?.prompt;
  const showToast = typedClient?.tui?.showToast;

  return async (sessionID, text) => {
    if (prompt) {
      try {
        await prompt({
          path: { sessionID },
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
