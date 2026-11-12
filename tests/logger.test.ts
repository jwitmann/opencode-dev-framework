import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLogger,
  LOG_SERVICE,
  resolveDefaultLogFile,
  rotateLogFile,
} from "../src/logger";

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

describe("resolveDefaultLogFile", () => {
  it("uses the XDG data dir on linux", () => {
    expect(
      resolveDefaultLogFile({
        platform: "linux",
        env: { XDG_DATA_HOME: "/data" },
        home: "/home/u",
      }),
    ).toBe(join("/data", "opencode-dev-framework", "opencode-dev-framework.log"));
  });

  it("falls back to ~/.local/share when XDG is unset", () => {
    expect(resolveDefaultLogFile({ platform: "linux", env: {}, home: "/home/u" })).toBe(
      join("/home/u", ".local", "share", "opencode-dev-framework", "opencode-dev-framework.log"),
    );
  });

  it("uses ~/Library/Logs on macOS", () => {
    expect(resolveDefaultLogFile({ platform: "darwin", env: {}, home: "/Users/u" })).toBe(
      join("/Users/u", "Library", "Logs", "opencode-dev-framework.log"),
    );
  });

  it("uses %LOCALAPPDATA% on Windows", () => {
    expect(
      resolveDefaultLogFile({
        platform: "win32",
        env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
        home: "C:\\Users\\u",
      }),
    ).toBe(
      join("C:\\Users\\u\\AppData\\Local", "opencode-dev-framework", "opencode-dev-framework.log"),
    );
  });

  it("falls back to tmp without a home dir, null when nothing is available", () => {
    expect(resolveDefaultLogFile({ platform: "linux", env: {}, home: null, tmp: "/tmp" })).toBe(
      join("/tmp", "opencode-dev-framework", "opencode-dev-framework.log"),
    );
    expect(resolveDefaultLogFile({ platform: "linux", env: {}, home: null, tmp: "" })).toBeNull();
  });
});

describe("createLogger file output", () => {
  it("writes JSON lines to the env-configured file, creating parent dirs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "odf-log-"));
    try {
      const file = join(dir, "nested", "test.log");
      const previous = process.env.OPENCODE_DEV_FRAMEWORK_LOG_FILE;
      process.env.OPENCODE_DEV_FRAMEWORK_LOG_FILE = file;
      try {
        const log = createLogger();
        await log("error", "gate failed", { sessionID: "s1" });
      } finally {
        if (previous === undefined) delete process.env.OPENCODE_DEV_FRAMEWORK_LOG_FILE;
        else process.env.OPENCODE_DEV_FRAMEWORK_LOG_FILE = previous;
      }
      const content = await readFile(file, "utf8");
      const line = JSON.parse(content.trim()) as { service: string; level: string };
      expect(line.service).toBe(LOG_SERVICE);
      expect(line.level).toBe("error");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rotates over-cap files keeping one backup, leaves the rest alone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "odf-log-"));
    try {
      const { writeFile } = await import("node:fs/promises");
      const big = join(dir, "big.log");
      await writeFile(big, "x".repeat(100));
      await rotateLogFile(big, 10);
      expect(await readFile(`${big}.1`, "utf8")).toBe("x".repeat(100));
      await expect(readFile(big, "utf8")).rejects.toThrow();

      const small = join(dir, "small.log");
      await writeFile(small, "tiny");
      await rotateLogFile(small, 1024);
      expect(await readFile(small, "utf8")).toBe("tiny");

      await expect(rotateLogFile(join(dir, "absent.log"), 10)).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
