import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installTemplates,
  listTemplateFiles,
  statusTemplates,
  writeDetectedConfig,
} from "../src/installer";

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
    expect(files).not.toContain(".opencode-dev-framework.yml");
    expect(files).not.toContain(".opencode/commands/df-verify.md");
    expect(files).toContain(".opencode/agents/test-grounder.md");
    expect(files).toContain(".opencode/agents/style-enforcer.md");
    expect(files).toContain(".opencode/skills/peer-review/SKILL.md");
  });
});

describe("installTemplates", () => {
  it("creates all templates in an empty directory", async () => {
    const result = await installTemplates(dir, { skipExisting: true });
    expect(result.created.length).toBeGreaterThan(0);
    expect(result.skipped).toEqual([]);
    expect(result.overwritten).toEqual([]);
    expect(result.created).not.toContain(".opencode-dev-framework.yml");
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
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, ".opencode/agents/test-grounder.md"), "custom", "utf8");
    const result = await installTemplates(dir, { overwriteExisting: true });
    expect(result.overwritten).toContain(".opencode/agents/test-grounder.md");
  });

  it("applies an 'overwrite-all' prompt answer to subsequent files", async () => {
    await installTemplates(dir, { skipExisting: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(dir, ".opencode/agents/test-grounder.md"),
      "---\ndescription: custom\n---\ncustom body\n",
      "utf8",
    );
    await writeFile(join(dir, ".opencode/agents/style-enforcer.md"), "custom", "utf8");

    let promptCalls = 0;
    const result = await installTemplates(dir, {
      prompt: async () => {
        promptCalls += 1;
        return "overwrite-all";
      },
    });

    expect(promptCalls).toBe(1);
    expect(result.overwritten).toContain(".opencode/agents/test-grounder.md");
    expect(result.overwritten).toContain(".opencode/agents/style-enforcer.md");
  });
});

describe("writeDetectedConfig", () => {
  it("creates a config file for an empty project", async () => {
    const result = await writeDetectedConfig(dir, { skipExisting: true });
    expect(result.action).toBe("created");
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(join(dir, ".opencode-dev-framework.yml"), "utf8");
    expect(content).toContain("profile: standard");
    expect(content).toContain("protect:");
  });

  it("detects Go tooling when go.mod is present", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "go.mod"), "module example.com/foo\n", "utf8");
    const result = await writeDetectedConfig(dir, { skipExisting: true });
    expect(result.action).toBe("created");
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(join(dir, ".opencode-dev-framework.yml"), "utf8");
    expect(content).toContain("test: go test ./...");
    expect(content).toContain("typecheck: go build ./...");
    expect(content).toContain("lint: golangci-lint run {file}");
  });

  it("skips an existing config when skipExisting is true", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, ".opencode-dev-framework.yml"), "profile: strict\n", "utf8");
    const result = await writeDetectedConfig(dir, { skipExisting: true });
    expect(result.action).toBe("skipped");
  });

  it("overwrites an existing config when overwriteExisting is true", async () => {
    const { writeFile, readFile } = await import("node:fs/promises");
    await writeFile(join(dir, ".opencode-dev-framework.yml"), "profile: strict\n", "utf8");
    const result = await writeDetectedConfig(dir, { overwriteExisting: true });
    expect(result.action).toBe("overwritten");
    const content = await readFile(join(dir, ".opencode-dev-framework.yml"), "utf8");
    expect(content).toContain("profile: standard");
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
});
