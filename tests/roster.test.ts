import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config";
import {
  findRosterIndex,
  MAX_ROSTER_ACCEPTANCE,
  ROSTER_MARKER,
  renderDutyRoster,
  rosterPresent,
} from "../src/roster";
import type { Config } from "../src/types";

function resolve(raw: Config) {
  return resolveConfig(raw, "/project/.opencode-dev-framework.yml");
}

describe("renderDutyRoster", () => {
  it("returns null for off", () => {
    expect(renderDutyRoster(resolve({ profile: "off" }))).toBeNull();
  });

  it("renders a minimal standard roster with test + budget", () => {
    const roster = renderDutyRoster(
      resolve({ profile: "standard", commands: { test: "npm test" } }),
    );
    expect(roster).toContain(ROSTER_MARKER);
    expect(roster).toContain("profile standard");
    expect(roster).toContain("- [ ] test (all): `npm test`");
    expect(roster).toContain("Budget: 3 blocks.");
  });

  it("renders the full strict roster in stable order", () => {
    const roster = renderDutyRoster(
      resolve({
        profile: "strict",
        commands: {
          typecheck: "npm run typecheck",
          test: "npm test",
          lint: "eslint {file}",
        },
        gate: {
          acceptance: [{ name: "e2e", command: "npm run e2e" }],
          require_review: true,
        },
        preflight: ["read ARCHITECTURE.md"],
      }),
    );
    const lines = roster?.split("\n") ?? [];
    const steps = lines.filter((l) => l.startsWith("- [ ]"));
    expect(steps).toEqual([
      "- [ ] typecheck: `npm run typecheck`",
      "- [ ] test (all): `npm test`",
      "- [ ] lint changed files: `eslint {file}`",
      "- [ ] acceptance:e2e: `npm run e2e`",
      `- [ ] review: write .opencode/opencode-dev-framework/review.md`,
      "- [ ] preflight: complete 1 task -> preflight.md before editing",
    ]);
  });

  it("marks advisory as non-blocking", () => {
    const roster = renderDutyRoster(
      resolve({ profile: "advisory", commands: { test: "npm test" } }),
    );
    expect(roster).toContain("advisory — failures warn, never block");
  });

  it("scopes the test step to changed when configured", () => {
    const roster = renderDutyRoster(
      resolve({
        profile: "standard",
        commands: { test_changed: "vitest related {files}" },
        gate: { scope: "changed" },
      }),
    );
    expect(roster).toContain("- [ ] test (changed): `vitest related {files}`");
  });

  it("says so explicitly when nothing is configured", () => {
    const roster = renderDutyRoster(
      resolve({
        profile: "standard",
        gate: { run_typecheck: false, run_tests: false, require_review: false },
      }),
    );
    expect(roster).toContain("No checks configured — gate will skip.");
  });

  it("collapses acceptance beyond the cap", () => {
    const acceptance = Array.from({ length: MAX_ROSTER_ACCEPTANCE + 2 }, (_, i) => ({
      name: `check${i}`,
      command: `verify-${i}`,
    }));
    const roster = renderDutyRoster(
      resolve({ profile: "standard", commands: { test: "true" }, gate: { acceptance } }),
    );
    expect(roster).toContain("+ 2 more acceptance checks");
  });

  it("truncates long commands", () => {
    const long = `npm run ${"x".repeat(200)}`;
    const roster = renderDutyRoster(resolve({ profile: "standard", commands: { test: long } }));
    expect(roster).not.toContain(long);
    expect(roster).toContain("…");
  });

  it("describes per-extension lint maps", () => {
    const roster = renderDutyRoster(
      resolve({
        profile: "strict",
        commands: { lint: { ".go": "golangci-lint run {file}" } },
        gate: { run_typecheck: false, run_tests: false, lint_changed: true },
      }),
    );
    expect(roster).toContain("per-extension (.go)");
  });
});

describe("roster prompt helpers", () => {
  it("detects exact roster presence and marker index", () => {
    const config = resolve({ profile: "standard", commands: { test: "npm test" } });
    const roster = renderDutyRoster(config);
    if (roster === null) throw new Error("expected a roster");
    const parts = [
      { type: "text" as const, text: "hello" },
      { type: "text" as const, text: roster },
    ];
    expect(rosterPresent(parts, roster)).toBe(true);
    expect(findRosterIndex(parts)).toBe(1);
    expect(findRosterIndex([{ type: "text" as const, text: "hello" }])).toBe(-1);
  });
});
