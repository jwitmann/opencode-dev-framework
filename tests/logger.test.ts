import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, LOG_SERVICE } from "../src/logger";

function stubClient(implementation?: () => Promise<void>) {
  const calls: { level: string; message: string; extra?: Record<string, unknown> }[] = [];
  const client = {
    app: {
      log: async (options: {
        body: { level: string; message: string; extra?: Record<string, unknown> };
      }) => {
        if (implementation) {
          await implementation();
          return;
        }
        calls.push(options.body);
      },
    },
  };
  return { client: client as never, calls };
}

describe("createLogger", () => {
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  afterEach(() => {
    stderrSpy.mockClear();
  });

  it("forwards level, message and extra to client.app.log", async () => {
    const { client, calls } = stubClient();
    const log = createLogger(client);
    await log("warn", "something happened", { key: "value" });
    expect(calls).toEqual([
      {
        service: LOG_SERVICE,
        level: "warn",
        message: "something happened",
        extra: { key: "value" },
      },
    ]);
  });

  it("uses the plugin service name", async () => {
    const logged: string[] = [];
    const client = {
      app: {
        log: async (options: { body: { service: string } }) => {
          logged.push(options.body.service);
        },
      },
    };
    const log = createLogger(client as never);
    await log("info", "hello");
    expect(logged).toEqual([LOG_SERVICE]);
  });

  it("falls back to stderr when app.log throws, and never rejects", async () => {
    const { client } = stubClient(async () => {
      throw new Error("app.log exploded");
    });
    const log = createLogger(client);
    await expect(log("error", "gate failed")).resolves.toBeUndefined();
    expect(stderrSpy).toHaveBeenCalledOnce();
    const written = String(stderrSpy.mock.calls[0]?.[0]);
    expect(written).toContain(LOG_SERVICE);
    expect(written).toContain("error gate failed");
    expect(written).toContain("app.log exploded");
  });

  it("resolves even when both app.log and stderr fail", async () => {
    const { client } = stubClient(async () => {
      throw new Error("app.log exploded");
    });
    stderrSpy.mockImplementationOnce(() => {
      throw new Error("stderr exploded");
    });
    const log = createLogger(client);
    await expect(log("error", "gate failed")).resolves.toBeUndefined();
  });
});
