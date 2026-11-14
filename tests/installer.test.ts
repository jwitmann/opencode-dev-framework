import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandResult, RunCommand, RunCommandOptions } from "../src/host";
import {
  buildWizardBrief,
  formatTrialRun,
  formatWizardBrief,
  installTemplates,
  listMakefileTargets,
  listTemplateFiles,
  statusTemplates,
  trialRunDetectedCommands,
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
    expect(files).toContain(".opencode/agents/test-grounder.md");
    expect(files).toContain(".opencode/agents/style-enforcer.md");
    expect(files).toContain(".opencode/agents/code-reviewer.md");
    expect(files).toContain(".opencode/skills/peer-review/SKILL.md");
    expect(files).toContain(".opencode/skills/code-review/SKILL.md");
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
    expect(content).toContain("lint: golangci-lint run {dir}");
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

describe("trialRunDetectedCommands (Phase 15)", () => {
  const ok: CommandResult = { stdout: "", stderr: "", exitCode: 0, timedOut: false };
  const fail: CommandResult = { stdout: "", stderr: "", exitCode: 1, timedOut: false };

  function stubRun(results: Record<string, CommandResult>): {
    run: RunCommand;
    calls: string[][];
  } {
    const calls: string[][] = [];
    const run: RunCommand = async (command) => {
      calls.push(command);
      return results[command[0]] ?? ok;
    };
    return { run, calls };
  }

  it("reports PASS per command with the command echoed", async () => {
    const { run, calls } = stubRun({});
    const results = await trialRunDetectedCommands(
      dir,
      { test: "npm test", typecheck: "true" },
      run,
    );
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ name: "test", command: "npm test", ok: true, exitCode: 0 });
    expect(results[1]).toMatchObject({ name: "typecheck", command: "true", ok: true });
    expect(calls).toEqual([["npm", "test"], ["true"]]);
    const lines = formatTrialRun(results);
    expect(lines[1]).toContain("test (npm test): PASS");
    expect(lines[2]).toContain("typecheck (true): PASS");
  });

  it("reports FAIL naming the command and exit code", async () => {
    const { run } = stubRun({ npm: fail });
    const results = await trialRunDetectedCommands(
      dir,
      { test: "npm test", typecheck: "true" },
      run,
    );
    expect(results[0]).toMatchObject({ name: "test", ok: false, exitCode: 1 });
    expect(results[1]).toMatchObject({ name: "typecheck", ok: true });
    const lines = formatTrialRun(results);
    expect(lines[1]).toContain("FAIL (exit 1)");
    expect(lines[1]).toContain("verify this command");
  });

  it("skips absent commands without failing", async () => {
    const { run, calls } = stubRun({});
    const results = await trialRunDetectedCommands(dir, { test: "npm test" }, run);
    expect(results).toHaveLength(1);
    expect(calls).toEqual([["npm", "test"]]);
  });

  it("reports nothing runnable when no commands are detected", async () => {
    const { run, calls } = stubRun({});
    const results = await trialRunDetectedCommands(dir, {}, run);
    expect(results).toEqual([]);
    expect(calls).toEqual([]);
    expect(formatTrialRun(results)[0]).toContain("no runnable commands");
  });

  it("records spawn failures as errors instead of throwing", async () => {
    const run: RunCommand = async () => {
      throw new Error("spawn ENOENT");
    };
    const results = await trialRunDetectedCommands(dir, { test: "npm test" }, run);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ name: "test", ok: false, exitCode: 127 });
    expect(results[0].error).toContain("ENOENT");
    expect(formatTrialRun(results)[1]).toContain("ERROR");
  });

  it("passes the timeout through to run and renders timed-out results", async () => {
    const seen: (RunCommandOptions | undefined)[] = [];
    const run: RunCommand = async (_command, options) => {
      seen.push(options);
      return { stdout: "", stderr: "", exitCode: 1, timedOut: true };
    };
    const results = await trialRunDetectedCommands(
      dir,
      { test: "npm test", typecheck: "true" },
      run,
      { timeout: 5 },
    );
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ timeout: 5 });
    expect(results[0]).toMatchObject({ name: "test", ok: false, timedOut: true });
    const lines = formatTrialRun(results);
    expect(lines[1]).toContain("FAIL (exit 1, timed out)");
    expect(lines[1]).toContain("verify this command");
  });
});

describe("project-config skill pin (Phase 15)", () => {
  it("ships the skill with the required section hooks", async () => {
    const files = await listTemplateFiles();
    expect(files).toContain(".opencode/skills/project-config/SKILL.md");
  });

  it("covers build truth, wrappers, acceptance, hardening draft, self-check, and review-only handoff", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { TEMPLATES_DIR } = await import("../src/installer");
    const content = await readFile(
      join(TEMPLATES_DIR, ".opencode/skills/project-config/SKILL.md"),
      "utf8",
    );
    for (const hook of [
      "CI workflow", // build truth, authority order
      "Prefer wrappers", // wrappers over bare tools
      "gate.acceptance", // non-unit scope placement
      "hardening.md", // hardening draft
      "block_on_failure", // enforceability self-check
      "Never write without review", // review-only handoff
    ]) {
      expect(content).toContain(hook);
    }
  });
});

describe("wizard brief (Phase 32)", () => {
  const ok: CommandResult = { stdout: "", stderr: "", exitCode: 0, timedOut: false };

  async function writeMakefile(content: string): Promise<void> {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "Makefile"), content, "utf8");
  }

  function stubRun(result: CommandResult): RunCommand {
    return async () => result;
  }

  it("lists Makefile targets, skipping dot-directives, vars, and pattern rules", async () => {
    await writeMakefile(
      ".PHONY: check test\n\ncheck: lint test\n\ntest:\n\tgo test ./...\n\n%.gz: %\n\tgzip -cn $< > $@\n\nFOO := bar\n",
    );
    expect(await listMakefileTargets(dir)).toEqual(["check", "test"]);
  });

  it("splits grouped targets and skips make keywords", async () => {
    await writeMakefile("lint test: deps\n\nexport FOO\n\ninclude extra.mk\n");
    expect(await listMakefileTargets(dir)).toEqual(["lint", "test"]);
  });

  it("prefers GNUmakefile, then lowercase makefile", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeMakefile("wrong:\n\tfalse\n");
    await writeFile(join(dir, "GNUmakefile"), "right:\n\ttrue\n", "utf8");
    expect(await listMakefileTargets(dir)).toEqual(["right"]);
  });

  it("returns no targets without a Makefile", async () => {
    expect(await listMakefileTargets(dir)).toEqual([]);
  });

  it("briefs detection, trial, targets, and the wrapper question", async () => {
    await writeMakefile("check: lint test\n\ntest:\n\tgo test ./...\n");
    const brief = await buildWizardBrief(dir, stubRun(ok));
    expect(brief.makeTargets).toEqual(["check", "test"]);
    expect(brief.trial).toHaveLength(0); // no package.json/go.mod in tmp dir
    expect(brief.enforceability.ok).toBe(true); // standard review default carries the bar
    expect(brief.questions.length).toBeLessThanOrEqual(3);
    expect(brief.questions[0]).toContain("Makefile targets detected");
    const lines = formatWizardBrief(brief);
    expect(lines[0]).toContain("Wizard brief");
    expect(lines.some((l) => l.includes("Makefile targets: check, test"))).toBe(true);
    expect(lines[lines.length - 1]).toContain("project-config skill");
  });

  it("renders the unenforceable verdict distinctly", () => {
    const lines = formatWizardBrief({
      language: "none",
      commands: {},
      trial: [],
      makeTargets: [],
      enforceability: { ok: false, error: "profile is off" },
      questions: ["Draft is not enforceable: profile is off"],
    });
    expect(lines.some((l) => l.includes("Enforceability: FAIL"))).toBe(true);
    expect(lines.some((l) => l.includes("1. Draft is not enforceable"))).toBe(true);
  });

  it("caps open questions at 3 with wrappers first", async () => {
    await writeMakefile("check:\n\tmake test\n");
    const fail: CommandResult = { stdout: "", stderr: "", exitCode: 1, timedOut: false };
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "package.json"), '{"scripts":{"test":"exit 1"}}', "utf8");
    await writeFile(join(dir, "tsconfig.json"), "{}", "utf8");
    const brief = await buildWizardBrief(dir, stubRun(fail));
    expect(brief.questions).toHaveLength(3);
    expect(brief.questions[0]).toContain("Makefile targets detected");
    expect(brief.questions[1]).toContain("Trial-run flagged test");
  });
});
