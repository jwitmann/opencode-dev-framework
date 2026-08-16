import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installTemplates, listTemplateFiles, statusTemplates } from "../src/installer";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "odf-installer-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("listTemplateFiles", () => {
  it("returns the bundled template files", async () => {
    const files = await listTemplateFiles();
    expect(files).toContain(".opencode-dev-framework.yml");
    expect(files).toContain(".opencode/commands/df-verify.md");
    expect(files).toContain(".opencode/commands/df-profile.md");
    expect(files).toContain(".opencode/agents/test-grounder.md");
    expect(files).toContain(".opencode/skills/peer-review/SKILL.md");
  });
});

describe("installTemplates", () => {
  it("creates all templates in an empty directory", async () => {
    const result = await installTemplates(dir, { skipExisting: true });
    expect(result.created.length).toBeGreaterThan(0);
    expect(result.skipped).toEqual([]);
    expect(result.overwritten).toEqual([]);
    expect(result.created).toContain(".opencode-dev-framework.yml");
  });

  it("skips existing files when skipExisting is true", async () => {
    await installTemplates(dir, { skipExisting: true });
    const result = await installTemplates(dir, { skipExisting: true });
    expect(result.created).toEqual([]);
    expect(result.skipped.length).toBeGreaterThan(0);
    expect(result.overwritten).toEqual([]);
  });

  it("overwrites existing files when overwriteExisting is true", async () => {
    await installTemplates(dir, { skipExisting: true });
    // Modify one file
    const path = join(dir, ".opencode-dev-framework.yml");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, "profile: strict\n", "utf8");
    const result = await installTemplates(dir, { overwriteExisting: true });
    expect(result.overwritten).toContain(".opencode-dev-framework.yml");
  });

  it("applies an 'overwrite-all' prompt answer to subsequent files", async () => {
    await installTemplates(dir, { skipExisting: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, ".opencode-dev-framework.yml"), "profile: strict\n", "utf8");
    await writeFile(
      join(dir, ".opencode/commands/df-verify.md"),
      "---\ndescription: custom\n---\ncustom body\n",
      "utf8",
    );

    let promptCalls = 0;
    const result = await installTemplates(dir, {
      prompt: async () => {
        promptCalls += 1;
        return "overwrite-all";
      },
    });

    // Prompted once; the second differing file used the sticky decision.
    expect(promptCalls).toBe(1);
    expect(result.overwritten).toContain(".opencode-dev-framework.yml");
    expect(result.overwritten).toContain(".opencode/commands/df-verify.md");
  });
});

describe("statusTemplates", () => {
  it("reports missing files in an empty directory", async () => {
    const status = await statusTemplates(dir);
    expect(status.missing.length).toBeGreaterThan(0);
    expect(status.present).toEqual([]);
    expect(status.different).toEqual([]);
  });

  it("reports present files after install", async () => {
    await installTemplates(dir, { skipExisting: true });
    const status = await statusTemplates(dir);
    expect(status.missing).toEqual([]);
    expect(status.present.length).toBeGreaterThan(0);
    expect(status.different).toEqual([]);
  });

  it("reports different files after modification", async () => {
    await installTemplates(dir, { skipExisting: true });
    const path = join(dir, ".opencode-dev-framework.yml");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, "profile: strict\n", "utf8");
    const status = await statusTemplates(dir);
    expect(status.different).toContain(".opencode-dev-framework.yml");
  });
});
