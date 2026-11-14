import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandResult, RunCommand } from "../src/host";
import {
  composeInitPrompt,
  initNeedsHandoff,
  runInitCommand,
  runInitScaffold,
  scaffoldReportLines,
} from "../src/init";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "odf-init-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ok: CommandResult = { stdout: "", stderr: "", exitCode: 0, timedOut: false };

function stubRun(): RunCommand {
  return async () => ok;
}

describe("runInitScaffold", () => {
  it("scaffolds templates and config in an empty directory, fresh", async () => {
    const scaffold = await runInitScaffold(dir, stubRun(), { wizard: true });
    expect(scaffold.created.length).toBeGreaterThan(0);
    expect(scaffold.configAction).toBe("created");
    expect(scaffold.fresh).toBe(true);
    expect(scaffold.detailLines.join("\n")).toContain("Wizard brief");
  });

  it("is a no-op the second time, reporting already-configured", async () => {
    await runInitScaffold(dir, stubRun(), { wizard: true });
    const second = await runInitScaffold(dir, stubRun(), { wizard: true });
    expect(second.created).toEqual([]);
    expect(second.overwritten).toEqual([]);
    expect(second.configAction).toBe("skipped");
    expect(second.fresh).toBe(false);
  });

  it("non-wizard mode trial-runs only when the config was written", async () => {
    const calls: string[][] = [];
    const run: RunCommand = async (command) => {
      calls.push(command);
      return ok;
    };
    const first = await runInitScaffold(dir, run, {});
    expect(first.fresh).toBe(true);
    expect(first.detailLines.join("\n")).toContain("Trial-run");
    const second = await runInitScaffold(dir, run, {});
    expect(second.fresh).toBe(false);
    expect(second.detailLines).toEqual([]);
  });

  it("does not rebuild the wizard brief on a no-op re-run", async () => {
    // A package.json with a test script makes detection yield runnable
    // commands, so the brief actually shells out on the first run.
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    const calls: string[][] = [];
    const run: RunCommand = async (command) => {
      calls.push(command);
      return ok;
    };
    await runInitScaffold(dir, run, { wizard: true });
    const trialCalls = calls.length;
    expect(trialCalls).toBeGreaterThan(0);
    const second = await runInitScaffold(dir, run, { wizard: true });
    expect(second.fresh).toBe(false);
    expect(second.detailLines).toEqual([]);
    expect(calls.length).toBe(trialCalls);
  });

  it("overwrite:true refreshes differing files (tool equivalence)", async () => {
    await runInitScaffold(dir, stubRun(), { wizard: true });
    await writeFile(join(dir, ".opencode/agents/test-grounder.md"), "custom", "utf8");
    const redo = await runInitScaffold(dir, stubRun(), { overwrite: true });
    expect(redo.overwritten).toContain(".opencode/agents/test-grounder.md");
    expect(redo.fresh).toBe(true);
  });
});

describe("scaffoldReportLines", () => {
  it("renders counts and created files without the brief", async () => {
    const scaffold = await runInitScaffold(dir, stubRun(), { wizard: true });
    const lines = scaffoldReportLines(scaffold, dir);
    expect(lines[0]).toContain(dir);
    expect(lines.join("\n")).toContain("Config: created");
    expect(lines.join("\n")).toContain("Created files:");
  });

  it("explains itself on a no-op re-run", async () => {
    await runInitScaffold(dir, stubRun(), { wizard: true });
    const second = await runInitScaffold(dir, stubRun(), { wizard: true });
    expect(scaffoldReportLines(second, dir).join("\n")).toContain("Already configured");
  });
});

describe("composeInitPrompt", () => {
  it("hands a fresh scaffold to the agent with standing instructions", async () => {
    const scaffold = await runInitScaffold(dir, stubRun(), { wizard: true });
    const text = composeInitPrompt(scaffold, dir);
    expect(text).toContain("Wizard brief");
    expect(text).toContain("at most 3 genuinely");
    expect(text).toContain("user-only questions");
    expect(text).toContain(".opencode-dev-framework.yml + hardening.md for review");
    expect(text).toContain("Do not commit unreviewed");
  });

  it("reports status instead of rebuilding when already configured", async () => {
    await runInitScaffold(dir, stubRun(), { wizard: true });
    const second = await runInitScaffold(dir, stubRun(), { wizard: true });
    const text = composeInitPrompt(second, dir);
    expect(text).toContain("already set up");
    expect(text).toContain("/df-status");
    expect(text).not.toContain("Wizard brief");
  });

  it("says untouched — not current — when templates drifted", async () => {
    await runInitScaffold(dir, stubRun(), { wizard: true });
    await writeFile(join(dir, ".opencode/agents/test-grounder.md"), "custom", "utf8");
    const second = await runInitScaffold(dir, stubRun(), { wizard: true });
    expect(second.fresh).toBe(false);
    expect(second.skipped).toContain(".opencode/agents/test-grounder.md");
    const text = composeInitPrompt(second, dir);
    expect(text).toContain("already set up");
    expect(text).toContain("differing-but-preserved");
    expect(text).toContain("were NOT refreshed");
  });

  it("carries reload warnings into the prompt instead of failing", async () => {
    const scaffold = await runInitScaffold(dir, stubRun(), { wizard: true });
    const text = composeInitPrompt(scaffold, dir, ["the new config could not be reloaded (boom)"]);
    expect(text).toContain("Warning: the new config could not be reloaded (boom)");
  });
});

describe("runInitCommand", () => {
  function deps(overrides: Record<string, unknown> = {}) {
    const delivered: { text: string; delivery: unknown }[] = [];
    const noted: { level: string; message: string }[] = [];
    let reloaded = 0;
    return {
      delivered,
      noted,
      reloaded: () => reloaded,
      base: {
        directory: dir,
        run: stubRun(),
        delivery: "steer",
        checkAlive: () => {},
        reload: async () => {
          reloaded += 1;
        },
        deliver: async (text: string, delivery: unknown) => {
          delivered.push({ text, delivery });
        },
        note: async (level: "warn", message: string) => {
          noted.push({ level, message });
        },
        ...overrides,
      },
    };
  }

  it("scaffolds, reloads, and delivers the handoff with delivery passthrough", async () => {
    const d = deps();
    await expect(runInitCommand(d.base)).resolves.toBe(true);
    expect(d.reloaded()).toBe(1);
    expect(d.delivered).toHaveLength(1);
    expect(d.delivered[0]?.delivery).toBe("steer");
    expect(d.delivered[0]?.text).toContain("Wizard brief");
    expect(d.delivered[0]?.text).toContain("at most 3 genuinely");
  });

  it("stays silent on a clean re-run (reload still runs, nothing delivered)", async () => {
    await runInitScaffold(dir, stubRun(), { wizard: true });
    const d = deps();
    await expect(runInitCommand(d.base)).resolves.toBe(false);
    expect(d.reloaded()).toBe(1);
    expect(d.delivered).toHaveLength(0);
  });

  it("hands off a non-fresh re-run when warnings exist", async () => {
    await runInitScaffold(dir, stubRun(), { wizard: true });
    const d = deps({
      reload: async () => {
        throw new Error("Invalid configuration in x");
      },
    });
    await expect(runInitCommand(d.base)).resolves.toBe(true);
    expect(d.delivered).toHaveLength(1);
    expect(d.delivered[0]?.text).toContain("could not be reloaded");
  });

  it("degrades a reload failure to a warning inside the prompt", async () => {
    const d = deps({
      reload: async () => {
        throw new Error("Invalid configuration in x");
      },
    });
    await runInitCommand(d.base);
    expect(d.delivered).toHaveLength(1);
    expect(d.delivered[0]?.text).toContain("could not be reloaded");
    expect(d.noted).toHaveLength(1);
    expect(d.noted[0]?.level).toBe("warn");
  });

  it("throws a recoverable error when delivery fails", async () => {
    const d = deps({
      deliver: async () => {
        throw new Error("ConflictError");
      },
    });
    await expect(runInitCommand(d.base)).rejects.toThrow(/retry \/df-init/);
  });

  it("refuses to mutate or deliver when stale", async () => {
    const d = deps({
      checkAlive: () => {
        throw new Error("retry /df-init");
      },
    });
    // Pre-seed so scaffold itself is a no-op: staleness must surface anyway.
    await runInitScaffold(dir, stubRun(), { wizard: true });
    await expect(runInitCommand(d.base)).rejects.toThrow(/retry \/df-init/);
    expect(d.reloaded()).toBe(0);
    expect(d.delivered).toHaveLength(0);
  });
});

describe("initNeedsHandoff", () => {
  const reRun = {
    created: [],
    overwritten: [],
    skipped: [],
    configAction: "skipped",
    detailLines: [],
    fresh: false,
  };
  it("is true for a fresh scaffold", () => {
    expect(initNeedsHandoff({ ...reRun, fresh: true })).toBe(true);
  });
  it("is false for a clean re-run", () => {
    expect(initNeedsHandoff(reRun)).toBe(false);
  });
  it("is true when warnings exist", () => {
    expect(initNeedsHandoff(reRun, ["the config could not be reloaded"])).toBe(true);
  });
});
