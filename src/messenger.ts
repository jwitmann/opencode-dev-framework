import type { PluginInput } from "@opencode-ai/plugin";

export type SendMessageFn = (sessionID: string, text: string) => Promise<void>;

/**
 * Create a messenger that posts a chat message without it being treated as a
 * user turn. OpenCode's `client.session.prompt` with `noReply: true` and an
 * `ignored: true` text part shows the message in the conversation UI but does
 * not feed it back to the model as input.
 */
export function createMessenger(client: PluginInput["client"]): SendMessageFn {
  const typedClient = client as
    | { session?: { prompt?: (input: unknown) => Promise<unknown> } }
    | undefined;
  const prompt = typedClient?.session?.prompt;
  if (!prompt) {
    return async () => {};
  }

  return async (sessionID, text) => {
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
  };
}
