import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderRuntimeStatus } from "../src/format-status";
import {
  readRuntimeStatus,
  snapshotPath,
  writeRuntimeStatus,
  type RuntimeStatus,
} from "../src/runtime-status";

describe("runtime status snapshot", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "df-runtime-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a snapshot through the project directory", async () => {
    await writeRuntimeStatus(dir, { idleHookVia: "experimental.idle", continuation: "armed" });
    const snapshot = await readRuntimeStatus(dir);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.idleHookVia).toBe("experimental.idle");
    expect(snapshot?.continuation).toBe("armed");
    expect(typeof snapshot?.frameworkVersion).toBe("string");
    expect(snapshot?.frameworkVersion.length).toBeGreaterThan(0);
    expect(typeof snapshot?.updatedAt).toBe("string");
    expect(snapshotPath(dir)).toBe(
      join(dir, ".opencode/opencode-dev-framework/runtime-status.json"),
    );
  });

  it("resolves the real plugin version from the repo package.json", async () => {
    await writeRuntimeStatus(dir, { idleHookVia: "none", continuation: "fallback" });
    const snapshot = await readRuntimeStatus(dir);
    expect(snapshot?.frameworkVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("returns null when no snapshot was written", async () => {
    await expect(readRuntimeStatus(dir)).resolves.toBeNull();
  });

  it("returns null for corrupt snapshots instead of throwing", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, ".opencode/opencode-dev-framework"), { recursive: true });
    writeFileSync(snapshotPath(dir), "{ not json", "utf8");
    await expect(readRuntimeStatus(dir)).resolves.toBeNull();
  });

  it("defaults unknown enum values instead of rejecting the snapshot", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, ".opencode/opencode-dev-framework"), { recursive: true });
    writeFileSync(
      snapshotPath(dir),
      JSON.stringify({
        frameworkVersion: "0.5.0",
        idleHookVia: "future-hook",
        continuation: "whatever",
        updatedAt: new Date().toISOString(),
      }),
      "utf8",
    );
    const snapshot = await readRuntimeStatus(dir);
    expect(snapshot?.idleHookVia).toBe("none");
    expect(snapshot?.continuation).toBe("armed");
  });
});

describe("renderRuntimeStatus", () => {
  const base: RuntimeStatus = {
    frameworkVersion: "0.5.0",
    idleHookVia: "experimental.idle",
    continuation: "armed",
    updatedAt: "2026-10-29T15:00:00.000Z",
  };

  it("renders null as not-reported, never as a negative hook claim", () => {
    const text = renderRuntimeStatus(null);
    expect(text).toContain("No runtime snapshot reported yet");
    expect(text).not.toContain("not registered");
  });

  it("renders version, hook method, and armed state", () => {
    const text = renderRuntimeStatus(base);
    expect(text).toContain("v0.5.0");
    expect(text).toContain("registered via experimental.idle");
    expect(text).toContain("armed — registered, not yet dispatched");
  });

  it("renders active continuation and unregistered hook distinctly", () => {
    expect(renderRuntimeStatus({ ...base, continuation: "idle" })).toContain("active");
    expect(
      renderRuntimeStatus({ ...base, idleHookVia: "none", continuation: "fallback" }),
    ).toContain("not registered — event-subscribe fallback only");
  });
});
