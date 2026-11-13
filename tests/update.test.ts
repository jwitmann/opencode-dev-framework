import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installTemplates, listTemplateFiles } from "../src/installer";
import {
  checkTemplateUpdates,
  composeUpdatePrompt,
  driftMentionLine,
  runUpdateCommand,
} from "../src/update";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "odf-update-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Install every shipped template, returning the installed set. */
async function installAll(): Promise<string[]> {
  const result = await installTemplates(dir, { skipExisting: true });
  return [...result.created].sort();
}

/** Leave only the first shipped file installed (the rest read as add). */
async function installFirstOnly(): Promise<string> {
  const all = await installAll();
  const first = all[0] as string;
  for (const name of all.slice(1)) {
    await rm(join(dir, name));
  }
  return first;
}

describe("checkTemplateUpdates", () => {
  it("reports empty on a tree with nothing installed", async () => {
    const drift = await checkTemplateUpdates(dir);
    const shipped = await listTemplateFiles();
    expect(drift.empty).toBe(true);
    expect(drift.add).toEqual([...shipped].sort());
    expect(drift.current).toEqual([]);
    expect(drift.refresh).toEqual([]);
  });

  it("reports current when everything matches", async () => {
    const all = await installAll();
    const drift = await checkTemplateUpdates(dir);
    expect(drift.empty).toBe(false);
    expect(drift.add).toEqual([]);
    expect(drift.refresh).toEqual([]);
    expect(drift.current).toEqual(all);
  });

  it("classifies modified files as refresh", async () => {
    const first = await installFirstOnly();
    await writeFile(join(dir, first), "customized", "utf8");
    const drift = await checkTemplateUpdates(dir);
    expect(drift.empty).toBe(false);
    expect(drift.refresh).toEqual([first]);
    expect(drift.add).not.toContain(first);
  });

  it("classifies absent files as add alongside current ones", async () => {
    const first = await installFirstOnly();
    const drift = await checkTemplateUpdates(dir);
    expect(drift.current).toEqual([first]);
    expect(drift.refresh).toEqual([]);
    expect(drift.add.length).toBeGreaterThan(0);
    expect(drift.add).not.toContain(first);
  });
});

describe("shipped template set", () => {
  it("never includes the user config", async () => {
    const shipped = await listTemplateFiles();
    expect(shipped).not.toContain(".opencode-dev-framework.yml");
    expect(shipped).not.toContain(".dev-framework.yml");
  });
});

describe("composeUpdatePrompt", () => {
  it("redirects an empty tree to /df-init", async () => {
    const drift = await checkTemplateUpdates(dir);
    const text = composeUpdatePrompt(drift, dir);
    expect(text).toContain("/df-init");
    expect(text).toContain("piecemeal");
  });

  it("reports status when current", async () => {
    await installAll();
    const drift = await checkTemplateUpdates(dir);
    const text = composeUpdatePrompt(drift, dir);
    expect(text).toContain("are current");
    expect(text).toContain("Nothing to do.");
  });

  it("hands drift plus approval rules to the agent", async () => {
    const first = await installFirstOnly();
    await writeFile(join(dir, first), "customized", "utf8");
    const drift = await checkTemplateUpdates(dir);
    const text = composeUpdatePrompt(drift, dir);
    expect(text).toContain(first);
    expect(text).toContain("only what the user approves");
    expect(text).toContain("run diff yourself");
    expect(text).toContain(".opencode-dev-framework.yml");
    expect(text).toContain("Never touch");
  });
});

describe("driftMentionLine", () => {
  it("names refresh/add counts and /df-update on drift", async () => {
    const first = await installFirstOnly();
    await writeFile(join(dir, first), "customized", "utf8");
    const drift = await checkTemplateUpdates(dir);
    const line = driftMentionLine(drift);
    expect(line).not.toBeNull();
    expect(line as string).toContain("/df-update");
    expect(line as string).toContain("1 to refresh");
    expect(line as string).toContain("to add");
  });

  it("returns null when current", async () => {
    await installAll();
    const drift = await checkTemplateUpdates(dir);
    expect(driftMentionLine(drift)).toBeNull();
  });

  it("returns null on an empty tree", async () => {
    const drift = await checkTemplateUpdates(dir);
    expect(driftMentionLine(drift)).toBeNull();
  });
});

describe("runUpdateCommand", () => {
  function deps(overrides: Record<string, unknown> = {}) {
    const delivered: { text: string; delivery: unknown }[] = [];
    return {
      delivered,
      base: {
        directory: dir,
        delivery: "steer",
        checkAlive: () => {},
        deliver: async (text: string, delivery: unknown) => {
          delivered.push({ text, delivery });
        },
        ...overrides,
      },
    };
  }

  it("delivers the drift report with delivery passthrough", async () => {
    await installFirstOnly();
    const d = deps();
    await runUpdateCommand(d.base);
    expect(d.delivered).toHaveLength(1);
    expect(d.delivered[0]?.delivery).toBe("steer");
    expect(d.delivered[0]?.text).toContain("to add");
  });

  it("refuses to deliver when stale", async () => {
    const d = deps({
      checkAlive: () => {
        throw new Error("retry /df-update");
      },
    });
    await expect(runUpdateCommand(d.base)).rejects.toThrow(/retry \/df-update/);
    expect(d.delivered).toHaveLength(0);
  });

  it("throws a recoverable error when delivery fails", async () => {
    const d = deps({
      deliver: async () => {
        throw new Error("ConflictError");
      },
    });
    await expect(runUpdateCommand(d.base)).rejects.toThrow(/retry \/df-update/);
  });
});
