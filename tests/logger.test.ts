import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLogger,
  LOG_SERVICE,
  MAX_LOG_BYTES,
  resolveDefaultLogFile,
  rotateLogFile,
} from "../src/core/logger";

describe("createLogger", () => {
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  // Sandbox the env override so these tests never touch the real
  // user-level default log (createLogger falls back to it when the
  // variable is unset).
  let previousLogFile: string | undefined;
  let sandboxDir: string;

  beforeEach(async () => {
    previousLogFile = process.env.OPENCODE_DEV_FRAMEWORK_LOG_FILE;
    sandboxDir = await mkdtemp(join(tmpdir(), "odf-log-env-"));
    process.env.OPENCODE_DEV_FRAMEWORK_LOG_FILE = join(sandboxDir, "sandbox.log");
  });

  afterEach(async () => {
    stderrSpy.mockClear();
    if (previousLogFile === undefined) delete process.env.OPENCODE_DEV_FRAMEWORK_LOG_FILE;
    else process.env.OPENCODE_DEV_FRAMEWORK_LOG_FILE = previousLogFile;
    await rm(sandboxDir, { recursive: true, force: true });
  });

  it("writes service, level, message and extra to stderr", async () => {
    const log = createLogger();
    await log("warn", "something happened", { key: "value" });
    const written = stderrSpy.mock.calls.map(String).join("\n");
    expect(written).toContain(`[${LOG_SERVICE}] warn something happened`);
    expect(written).toContain(`extra: ${JSON.stringify({ key: "value" })}`);
  });

  it("never rejects when stderr fails", async () => {
    stderrSpy.mockImplementationOnce(() => {
      throw new Error("stderr exploded");
    });
    const log = createLogger();
    await expect(log("error", "gate failed")).resolves.toBeUndefined();
  });

  describe("OPENCODE_DEV_FRAMEWORK_LOG_LEVEL", () => {
    let previousLevel: string | undefined;

    beforeEach(() => {
      previousLevel = process.env.OPENCODE_DEV_FRAMEWORK_LOG_LEVEL;
    });

    afterEach(() => {
      if (previousLevel === undefined) delete process.env.OPENCODE_DEV_FRAMEWORK_LOG_LEVEL;
      else process.env.OPENCODE_DEV_FRAMEWORK_LOG_LEVEL = previousLevel;
    });

    it("drops below-minimum levels everywhere (stderr, file)", async () => {
      process.env.OPENCODE_DEV_FRAMEWORK_LOG_LEVEL = "warn";
      const log = createLogger();
      await log("debug", "quiet");
      await log("info", "also quiet");
      await log("warn", "loud");
      await log("error", "louder");
      const written = stderrSpy.mock.calls.map(String).join("\n");
      expect(written).toContain("loud");
      expect(written).toContain("louder");
      expect(written).not.toContain("quiet");
    });

    it("treats unknown values as debug (current behavior)", async () => {
      process.env.OPENCODE_DEV_FRAMEWORK_LOG_LEVEL = "verbose";
      await createLogger()("debug", "still here");
      expect(stderrSpy.mock.calls.map(String).join("\n")).toContain("still here");
    });
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

  it("falls back to ~/.local/share when XDG is unset or empty", () => {
    expect(resolveDefaultLogFile({ platform: "linux", env: {}, home: "/home/u" })).toBe(
      join("/home/u", ".local", "share", "opencode-dev-framework", "opencode-dev-framework.log"),
    );
    expect(
      resolveDefaultLogFile({ platform: "linux", env: { XDG_DATA_HOME: "" }, home: "/home/u" }),
    ).toBe(
      join("/home/u", ".local", "share", "opencode-dev-framework", "opencode-dev-framework.log"),
    );
  });

  it("ignores a relative XDG data dir (would land relative to CWD)", () => {
    expect(
      resolveDefaultLogFile({
        platform: "linux",
        env: { XDG_DATA_HOME: "rel/dir" },
        home: "/home/u",
      }),
    ).toBe(
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

  it("rotates through the wired log() path, not just direct calls", async () => {
    const dir = await mkdtemp(join(tmpdir(), "odf-log-"));
    try {
      const file = join(dir, "wired.log");
      await writeFile(file, "x".repeat(MAX_LOG_BYTES + 1));
      const previous = process.env.OPENCODE_DEV_FRAMEWORK_LOG_FILE;
      process.env.OPENCODE_DEV_FRAMEWORK_LOG_FILE = file;
      try {
        await createLogger()("error", "after rotation");
      } finally {
        if (previous === undefined) delete process.env.OPENCODE_DEV_FRAMEWORK_LOG_FILE;
        else process.env.OPENCODE_DEV_FRAMEWORK_LOG_FILE = previous;
      }
      expect(await readFile(`${file}.1`, "utf8")).toBe("x".repeat(MAX_LOG_BYTES + 1));
      expect(await readFile(file, "utf8")).toContain("after rotation");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
