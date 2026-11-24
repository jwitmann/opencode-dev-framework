import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TEMPLATES_DIR } from "../src/core/installer";

const READ_ONLY = ["code-reviewer", "pattern-guardian", "style-enforcer"];
const ALL = [...READ_ONLY, "test-grounder"];

// Deprecated V1 frontmatter keys (migration guide "Agent files"): a file
// using a V2 trigger field with any of these present gets them ignored
// with a warning, so none may appear.
const V1_KEYS = ["name:", "permission:", "tools:", "prompt:", "disable:", "maxSteps"];

function frontmatter(body: string): string {
  const match = body.match(/^---\n([\s\S]*?)\n---\n/);
  expect(match, "agent file must start with a frontmatter block").not.toBeNull();
  return match![1]!;
}

function editDeny(fm: string): boolean {
  return fm.includes("action: edit") && fm.includes('resource: "*"') && fm.includes("effect: deny");
}

function shellDeny(fm: string): boolean {
  return (
    fm.includes("action: shell") && fm.includes('resource: "*"') && fm.includes("effect: deny")
  );
}

describe("shipped reviewer agents", () => {
  for (const agent of ALL) {
    it(`${agent} is a subagent with edit denied and no V1 keys`, async () => {
      const body = await readFile(
        join(TEMPLATES_DIR, ".opencode", "agents", `${agent}.md`),
        "utf8",
      );
      const fm = frontmatter(body);
      expect(fm).toContain("mode: subagent");
      expect(editDeny(fm)).toBe(true);
      for (const key of V1_KEYS) {
        expect(fm).not.toContain(key);
      }
    });
  }

  for (const agent of READ_ONLY) {
    it(`${agent} also denies shell (pure reader)`, async () => {
      const body = await readFile(
        join(TEMPLATES_DIR, ".opencode", "agents", `${agent}.md`),
        "utf8",
      );
      expect(shellDeny(frontmatter(body))).toBe(true);
    });
  }

  it("test-grounder keeps shell (runs verification commands)", async () => {
    const body = await readFile(
      join(TEMPLATES_DIR, ".opencode", "agents", "test-grounder.md"),
      "utf8",
    );
    expect(shellDeny(frontmatter(body))).toBe(false);
  });
});
