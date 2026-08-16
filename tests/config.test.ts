import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearConfigCache,
  DEFAULT_PROTECT,
  findConfigFile,
  loadConfig,
  mapFlatConfig,
  resolveConfig,
  splitGlobs,
} from "../src/config";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "odf-config-"));
  clearConfigCache();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): void {
  writeFileSync(join(dir, name), content);
}

describe("findConfigFile", () => {
  it("returns undefined when no config file exists", () => {
    expect(findConfigFile(dir)).toBeUndefined();
  });

  it("prefers .opencode-dev-framework.yml over the fallback", () => {
    write(".dev-framework.yml", "profile: strict\n");
    write(".opencode-dev-framework.yml", "profile: advisory\n");
    expect(findConfigFile(dir)).toBe(join(dir, ".opencode-dev-framework.yml"));
    expect(loadConfig(dir).profile).toBe("advisory");
  });
});

describe("loadConfig (native YAML)", () => {
  it("loads a native YAML config", () => {
    write(
      ".opencode-dev-framework.yml",
      [
        "profile: strict",
        "commands:",
        "  test: go test ./...",
        "  format:",
        "    .go: gofumpt -w {file}",
        "protect:",
        "  - .env*",
        "  - go.sum",
        "gate:",
        "  scope: changed",
        "  timeout: 120",
        "",
      ].join("\n"),
    );
    const config = loadConfig(dir);
    expect(config.profile).toBe("strict");
    expect(config.commands.test).toBe("go test ./...");
    expect(config.commands.format).toEqual({ ".go": "gofumpt -w {file}" });
    expect(config.protect).toEqual([".env*", "go.sum"]);
    expect(config.gate.scope).toBe("changed");
    expect(config.gate.timeout).toBe(120);
    expect(config.configPath).toBe(join(dir, ".opencode-dev-framework.yml"));
  });

  it("loads a JSON config", () => {
    write(".opencode-dev-framework.json", JSON.stringify({ profile: "advisory" }));
    expect(loadConfig(dir).profile).toBe("advisory");
  });

  it("throws a readable error for invalid config", () => {
    write(".opencode-dev-framework.yml", "profile: banana\n");
    expect(() => loadConfig(dir)).toThrowError(/Invalid configuration in .*profile/s);
  });
});

describe("loadConfig (.dev-framework.yml fallback)", () => {
  it("maps flat keys to the native structure", () => {
    write(
      ".dev-framework.yml",
      [
        "profile: strict",
        "test: go test ./...",
        "typecheck: go vet ./...",
        "format.go: gofumpt -w {file}",
        "lint.go: golangci-lint run {file}",
        "test_changed: go test {files}",
        "format_on_edit: false",
        "gate_scope: changed",
        "gate_timeout: 300",
        "protect: .env* go.sum",
        "protect_mode: warn",
        "",
      ].join("\n"),
    );
    const config = loadConfig(dir);
    expect(config.profile).toBe("strict");
    expect(config.commands.test).toBe("go test ./...");
    expect(config.commands.typecheck).toBe("go vet ./...");
    expect(config.commands.format).toEqual({ ".go": "gofumpt -w {file}" });
    expect(config.commands.lint).toEqual({ ".go": "golangci-lint run {file}" });
    expect(config.commands.test_changed).toBe("go test {files}");
    expect(config.on_edit.format).toBe(false);
    expect(config.gate.scope).toBe("changed");
    expect(config.gate.timeout).toBe(300);
    expect(config.protect).toEqual([".env*", "go.sum"]);
    expect(config.protect_mode).toBe("warn");
  });
});

describe("profile defaults", () => {
  it("defaults to off when no config file exists", () => {
    const config = loadConfig(dir);
    expect(config.profile).toBe("off");
    expect(config.on_edit).toEqual({ format: false, lint: false });
    expect(config.gate.block_on_failure).toBe(false);
    expect(config.protect).toEqual(DEFAULT_PROTECT);
  });

  it("defaults to standard when a config file exists without a profile", () => {
    write(".opencode-dev-framework.yml", "commands:\n  test: npm test\n");
    const config = loadConfig(dir);
    expect(config.profile).toBe("standard");
    expect(config.protect_mode).toBe("deny");
    expect(config.gate.block_on_failure).toBe(true);
  });

  it("applies advisory defaults", () => {
    write(".opencode-dev-framework.yml", "profile: advisory\n");
    const config = loadConfig(dir);
    expect(config.protect_mode).toBe("warn");
    expect(config.gate.block_on_failure).toBe(false);
    expect(config.on_edit).toEqual({ format: true, lint: true });
  });

  it("applies strict defaults", () => {
    write(".opencode-dev-framework.yml", "profile: strict\n");
    const config = loadConfig(dir);
    expect(config.gate.lint_changed).toBe(true);
    expect(config.protect_mode).toBe("deny");
  });

  it("lets explicit keys override profile defaults", () => {
    write(
      ".opencode-dev-framework.yml",
      ["profile: strict", "protect_mode: warn", "gate:", "  lint_changed: false", ""].join("\n"),
    );
    const config = loadConfig(dir);
    expect(config.protect_mode).toBe("warn");
    expect(config.gate.lint_changed).toBe(false);
  });
});

describe("caching", () => {
  it("caches the resolved config per directory", () => {
    write(".opencode-dev-framework.yml", "profile: advisory\n");
    const first = loadConfig(dir);
    write(".opencode-dev-framework.yml", "profile: strict\n");
    expect(loadConfig(dir)).toBe(first);
    clearConfigCache();
    expect(loadConfig(dir).profile).toBe("strict");
  });
});

describe("mapFlatConfig helpers", () => {
  it("splits whitespace-separated globs", () => {
    expect(splitGlobs(".env* go.sum  bin/")).toEqual([".env*", "go.sum", "bin/"]);
    expect(splitGlobs(["a", "b"])).toEqual(["a", "b"]);
    expect(splitGlobs(undefined)).toEqual([]);
  });

  it("maps a nested format map as per-extension overrides", () => {
    const config = mapFlatConfig({ format: { ".py": "ruff format {file}" } });
    expect(config.commands?.format).toEqual({ ".py": "ruff format {file}" });
  });

  it("ignores unknown keys but maps precommit", () => {
    const config = mapFlatConfig({ precommit: "auto", whatever: 1 });
    expect(config).toEqual({ precommit: "auto" });
  });
});

describe("resolveConfig", () => {
  it("resolves an empty config as off", () => {
    const config = resolveConfig({});
    expect(config.profile).toBe("off");
    expect(config.gate.scope).toBe("all");
    expect(config.gate.max_blocks).toBe(3);
  });
});
