import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config";
import { changeProfile, verifyGate } from "../src/commands";
import { clearConfigCache } from "../src/config";
import type { RunCommand } from "../src/host";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "odf-commands-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("changeProfile helper", () => {
  it("edits the profile key in the config file", async () => {
    await writeFile(
      join(dir, ".opencode-dev-framework.yml"),
      "profile: standard\n\nprotect:\n  - .env\n",
    );
    clearConfigCache();
    const message = await changeProfile(dir, "strict");
    expect(message).toContain('profile set to "strict"');
    const content = await readFile(join(dir, ".opencode-dev-framework.yml"), "utf8");
    expect(content).toContain("profile: strict");
    // Original content preserved (text edit, not re-serialize).
    expect(content).toContain("protect:");
  });

  it("creates the config file when missing", async () => {
    const message = await changeProfile(dir, "advisory");
    expect(message).toContain('profile set to "advisory"');
    const content = await readFile(join(dir, ".opencode-dev-framework.yml"), "utf8");
    expect(content).toContain("profile: advisory");
  });
});

describe("verifyGate helper", () => {
  it("runs the gate and reports success", async () => {
    const config = resolveConfig(
      { profile: "standard", commands: { test: "echo ok" } },
      join(dir, ".opencode-dev-framework.yml"),
    );
    const run: RunCommand = async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
    const { report, summary } = await verifyGate(run, dir, config);
    expect(report.ok).toBe(true);
    expect(summary).toContain("completion gate");
  });

  it("reports failure when a command exits non-zero", async () => {
    const config = resolveConfig(
      { profile: "standard", commands: { test: "exit 1" }, gate: { skip_unchanged: false } },
      join(dir, ".opencode-dev-framework.yml"),
    );
    const run: RunCommand = async () => ({
      stdout: "",
      stderr: "boom",
      exitCode: 1,
      timedOut: false,
    });
    const { report } = await verifyGate(run, dir, config);
    expect(report.ok).toBe(false);
  });

  it("returns a PASS verdict with the stable first line when green and reviewed", async () => {
    await mkdir(join(dir, ".opencode", "opencode-dev-framework"), { recursive: true });
    await writeFile(join(dir, ".opencode", "opencode-dev-framework", "review.md"), "reviewed");
    const config = resolveConfig(
      { profile: "standard", commands: { typecheck: "echo ok" }, gate: { run_tests: false } },
      join(dir, ".opencode-dev-framework.yml"),
    );
    const run: RunCommand = async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
    const { verdict, summary } = await verifyGate(run, dir, config, ["src/a.ts"]);
    expect(verdict).toBe("PASS");
    expect(summary.startsWith("DEV_FRAMEWORK_VERDICT: PASS")).toBe(true);
    expect(summary).toContain("completion gate passed");
  });

  it("returns FAIL when review is required but missing", async () => {
    const config = resolveConfig(
      { profile: "standard", commands: { typecheck: "echo ok" }, gate: { run_tests: false } },
      join(dir, ".opencode-dev-framework.yml"),
    );
    const run: RunCommand = async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
    const { verdict, summary } = await verifyGate(run, dir, config, ["src/a.ts"]);
    expect(verdict).toBe("FAIL");
    expect(summary.startsWith("DEV_FRAMEWORK_VERDICT: FAIL")).toBe(true);
    expect(summary).toContain("peer-review loop has not run");
  });

  it("returns FAIL when a command fails even though review exists", async () => {
    await mkdir(join(dir, ".opencode", "opencode-dev-framework"), { recursive: true });
    await writeFile(join(dir, ".opencode", "opencode-dev-framework", "review.md"), "reviewed");
    const config = resolveConfig(
      { profile: "standard", commands: { typecheck: "exit 1" }, gate: { run_tests: false } },
      join(dir, ".opencode-dev-framework.yml"),
    );
    const run: RunCommand = async () => ({
      stdout: "",
      stderr: "boom",
      exitCode: 1,
      timedOut: false,
    });
    const { verdict, summary } = await verifyGate(run, dir, config, ["src/a.ts"]);
    expect(verdict).toBe("FAIL");
    expect(summary).toContain("typecheck: failed");
  });

  it("reports raw FAIL in advisory (no blocking language, no PASS conversion)", async () => {
    const config = resolveConfig(
      { profile: "advisory", commands: { typecheck: "exit 1" }, gate: { run_tests: false } },
      join(dir, ".opencode-dev-framework.yml"),
    );
    const run: RunCommand = async () => ({
      stdout: "",
      stderr: "boom",
      exitCode: 1,
      timedOut: false,
    });
    const { verdict, summary } = await verifyGate(run, dir, config, ["src/a.ts"]);
    expect(verdict).toBe("FAIL");
    expect(summary.startsWith("DEV_FRAMEWORK_VERDICT: FAIL")).toBe(true);
  });

  it("unions git-discovered files with the tracker snapshot", async () => {
    const config = resolveConfig(
      { profile: "standard", commands: { typecheck: "true", test: "true" } },
      join(dir, ".opencode-dev-framework.yml"),
    );
    const run: RunCommand = async (command) => {
      if (command[0] === "git")
        return { stdout: "?? src/new.ts\n", stderr: "", exitCode: 0, timedOut: false };
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    };
    const { inspection, report } = await verifyGate(run, dir, config, []);
    // Tracker was empty, but git discovery found the new file and ran the gate.
    expect(inspection.changedFiles).toEqual(["src/new.ts"]);
    expect(report.steps.some((s) => s.name === "typecheck" && !s.skipped)).toBe(true);
  });

  it("does not mutate the caller's changed-file snapshot", async () => {
    const config = resolveConfig(
      { profile: "standard", commands: { typecheck: "echo ok" }, gate: { run_tests: false } },
      join(dir, ".opencode-dev-framework.yml"),
    );
    const run: RunCommand = async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
    const snapshot = ["src/a.ts"];
    await verifyGate(run, dir, config, snapshot);
    expect(snapshot).toEqual(["src/a.ts"]);
  });
});
