import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectProject, detectedConfigYaml } from "../src/detect";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "odf-detect-"));
}

describe("detectProject", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("detects a Node project with TypeScript", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    const result = detectProject(dir);
    expect(result.language).toBe("node");
    expect(result.commands.test).toBe("npm test");
    expect(result.commands.typecheck).toBe("npx tsc --noEmit");
  });

  it("detects eslint/prettier when present in devDependencies", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ devDependencies: { eslint: "^9", prettier: "^3" } }),
    );
    const result = detectProject(dir);
    expect(result.commands.lint).toBe("npx eslint {file}");
    expect(result.commands.format).toBe("npx prettier --write {file}");
  });

  it("detects Go", () => {
    writeFileSync(join(dir, "go.mod"), "module example.com/foo\n");
    const result = detectProject(dir);
    expect(result.language).toBe("go");
    expect(result.commands.test).toBe("go test ./...");
    expect(result.commands.typecheck).toBe("go build ./...");
    expect(result.commands.lint).toBe("golangci-lint run {file}");
  });

  it("detects Python", () => {
    writeFileSync(join(dir, "requirements.txt"), "requests\n");
    const result = detectProject(dir);
    expect(result.language).toBe("python");
    expect(result.commands.test).toBe("pytest");
    expect(result.commands.lint).toBe("flake8 {file}");
  });

  it("detects Rust", () => {
    writeFileSync(join(dir, "Cargo.toml"), "[package]\nname = 'foo'\n");
    const result = detectProject(dir);
    expect(result.language).toBe("rust");
    expect(result.commands.test).toBe("cargo test");
    expect(result.commands.typecheck).toBe("cargo check");
  });

  it("detects pre-commit config", () => {
    writeFileSync(join(dir, ".pre-commit-config.yaml"), "repos: []\n");
    const result = detectProject(dir);
    expect(result.hasPreCommitConfig).toBe(true);
    expect(result.language).toBeNull();
  });

  it("returns empty detection for unknown projects", () => {
    const result = detectProject(dir);
    expect(result.language).toBeNull();
    expect(result.commands).toEqual({});
    expect(result.hasPreCommitConfig).toBe(false);
  });
});

describe("detectedConfigYaml", () => {
  it("renders commands as YAML", () => {
    const yaml = detectedConfigYaml("go", {
      test: "go test ./...",
      typecheck: "go build ./...",
      lint: "golangci-lint run {file}",
    });
    expect(yaml).toContain("profile: standard");
    expect(yaml).toContain("# Detected language: go");
    expect(yaml).toContain("test: go test ./...");
    expect(yaml).toContain("typecheck: go build ./...");
    expect(yaml).toContain("lint: golangci-lint run {file}");
  });

  it("renders per-extension command maps", () => {
    const yaml = detectedConfigYaml("node", {
      format: { ".js": "prettier --write {file}" },
      lint: { ".ts": "eslint {file}" },
    });
    expect(yaml).toContain("format:");
    expect(yaml).toContain("  .js: prettier --write {file}");
    expect(yaml).toContain("  .ts: eslint {file}");
  });
});
