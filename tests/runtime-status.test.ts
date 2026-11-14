import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    mkdirSync(join(dir, ".opencode/opencode-dev-framework"), { recursive: true });
    writeFileSync(snapshotPath(dir), "{ not json", "utf8");
    await expect(readRuntimeStatus(dir)).resolves.toBeNull();
  });

  it("defaults unknown enum values instead of rejecting the snapshot", async () => {
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

  it("round-trips template state", async () => {
    await writeRuntimeStatus(dir, {
      idleHookVia: "experimental.idle",
      continuation: "armed",
      templates: { state: "drifted", current: 7, total: 10, refresh: 1, add: 2 },
    });
    expect(await readRuntimeStatus(dir)).toMatchObject({
      templates: { state: "drifted", current: 7, total: 10, refresh: 1, add: 2 },
    });
  });

  it("tolerates snapshots without template state (older servers)", async () => {
    mkdirSync(join(dir, ".opencode/opencode-dev-framework"), { recursive: true });
    writeFileSync(
      snapshotPath(dir),
      JSON.stringify({
        frameworkVersion: "1.9.0",
        idleHookVia: "idle",
        continuation: "armed",
        updatedAt: new Date().toISOString(),
      }),
      "utf8",
    );
    const snapshot = await readRuntimeStatus(dir);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.templates).toBeUndefined();
  });

  it("drops invalid template state instead of rejecting the snapshot", async () => {
    mkdirSync(join(dir, ".opencode/opencode-dev-framework"), { recursive: true });
    writeFileSync(
      snapshotPath(dir),
      JSON.stringify({
        frameworkVersion: "1.9.0",
        idleHookVia: "idle",
        continuation: "armed",
        templates: { state: "whatever", current: "7" },
        updatedAt: new Date().toISOString(),
      }),
      "utf8",
    );
    const snapshot = await readRuntimeStatus(dir);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.templates).toBeUndefined();
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

  it("renders template state unknown when the snapshot predates it", () => {
    const text = renderRuntimeStatus(base);
    expect(text).toContain("Templates: state unknown");
    expect(text).not.toContain("/df-update");
  });

  it("renders the three template states with the right command", () => {
    expect(
      renderRuntimeStatus({
        ...base,
        templates: { state: "current", current: 10, total: 10, refresh: 0, add: 0 },
      }),
    ).toContain("Templates: up to date (10/10 match)");
    const drifted = renderRuntimeStatus({
      ...base,
      templates: { state: "drifted", current: 7, total: 10, refresh: 1, add: 2 },
    });
    expect(drifted).toContain("Templates: drifted (1 to refresh, 2 to add)");
    expect(drifted).toContain("/df-update");
    expect(
      renderRuntimeStatus({
        ...base,
        templates: { state: "empty", current: 0, total: 10, refresh: 0, add: 10 },
      }),
    ).toContain("Templates: not installed — run /df-init");
  });
});
