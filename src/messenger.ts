import type { PluginInput } from "@opencode-ai/plugin";

export type SendMessageFn = (sessionID: string, text: string) => Promise<void>;

/**
 * Create a messenger that posts a chat message without it being treated as a
 * user turn.
 *
 * The installed `@opencode-ai/sdk` is v1.x (matching the plugin's dependency).
 * Its `client.session.prompt` expects the wrapper:
 *
 * ```
 * {
 *   path: { id: sessionID },
 *   body: {
 *     noReply: true,
 *     parts: [{ type: "text", text: string, synthetic: true }],
 *   },
 * }
 * ```
 *
 * `synthetic: true` marks the message as system-generated so it is visible in
 * the conversation but is not fed back to the model as a user turn. The older
 * `ignored: true` flag hides the message from the UI but still includes it in
 * the model context, which is why the previous attempt leaked the status into
 * the next assistant turn.
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
          path: { id: sessionID },
          body: {
            noReply: true,
            parts: [
              {
                type: "text",
                text,
                synthetic: true,
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
