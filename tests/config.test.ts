import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearConfigCache,
  DEFAULT_PROTECT,
  findConfigFile,
  hasMeaningfulChecks,
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
        "gate_require_review: false",
        "preflight: |",
        "  Load recent backtest results",
        "  Summarize the current strategy config",
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
    expect(config.gate.require_review).toBe(false);
    expect(config.preflight).toEqual([
      "Load recent backtest results",
      "Summarize the current strategy config",
    ]);
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
    expect(config.gate.require_review).toBe(false);
    expect(config.preflight).toEqual([]);
    expect(config.protect).toEqual(DEFAULT_PROTECT);
  });

  it("defaults to standard when a config file exists without a profile", () => {
    write(".opencode-dev-framework.yml", "commands:\n  test: npm test\n");
    const config = loadConfig(dir);
    expect(config.profile).toBe("standard");
    expect(config.protect_mode).toBe("deny");
    expect(config.gate.block_on_failure).toBe(true);
    expect(config.gate.require_review).toBe(true);
  });

  it("applies advisory defaults", () => {
    write(".opencode-dev-framework.yml", "profile: advisory\n");
    const config = loadConfig(dir);
    expect(config.protect_mode).toBe("warn");
    expect(config.gate.block_on_failure).toBe(false);
    expect(config.gate.require_review).toBe(true);
    expect(config.on_edit).toEqual({ format: true, lint: true });
  });

  it("applies strict defaults", () => {
    write(".opencode-dev-framework.yml", "profile: strict\n");
    const config = loadConfig(dir);
    expect(config.gate.lint_changed).toBe(true);
    expect(config.gate.require_review).toBe(true);
    expect(config.protect_mode).toBe("deny");
  });

  it("loads a native preflight task list and honors gate.require_review overrides", () => {
    write(
      ".opencode-dev-framework.yml",
      [
        "profile: strict",
        "gate:",
        "  require_review: false",
        "preflight:",
        "  - Task one",
        "  - Task two",
        "",
      ].join("\n"),
    );
    const config = loadConfig(dir);
    expect(config.gate.require_review).toBe(false);
    expect(config.preflight).toEqual(["Task one", "Task two"]);
  });

  it("accepts preflight as a single multi-line string", () => {
    write(
      ".opencode-dev-framework.yml",
      ["preflight: |", "  Task one", "  Task two", ""].join("\n"),
    );
    const config = loadConfig(dir);
    expect(config.preflight).toEqual(["Task one", "Task two"]);
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

describe("hasMeaningfulChecks", () => {
  it("a default standard config with commands is meaningful", () => {
    expect(
      hasMeaningfulChecks(resolveConfig({ profile: "standard", commands: { typecheck: "true" } })),
    ).toBe(true);
  });

  it("an empty config is vacuous", () => {
    expect(hasMeaningfulChecks(resolveConfig({}))).toBe(false);
  });

  it("a bare blocking profile with no commands is vacuous without review", () => {
    const config = resolveConfig({
      profile: "standard",
      gate: {
        run_typecheck: false,
        run_tests: false,
        lint_changed: false,
        require_review: false,
        block_on_failure: true,
      },
    });
    expect(hasMeaningfulChecks(config)).toBe(false);
  });

  it("counts review, acceptance, tests, and lint independently", () => {
    const base = {
      profile: "standard",
      gate: {
        run_typecheck: false,
        run_tests: false,
        lint_changed: false,
        require_review: false,
        block_on_failure: true,
      },
    } as const;
    expect(
      hasMeaningfulChecks(resolveConfig({ ...base, gate: { ...base.gate, require_review: true } })),
    ).toBe(true);
    expect(
      hasMeaningfulChecks(
        resolveConfig({
          ...base,
          gate: { ...base.gate, acceptance: [{ name: "c", command: "./v.sh" }] },
        }),
      ),
    ).toBe(true);
    expect(
      hasMeaningfulChecks(
        resolveConfig({
          ...base,
          commands: { test: "go test ./..." },
          gate: { ...base.gate, run_tests: true },
        }),
      ),
    ).toBe(true);
    expect(
      hasMeaningfulChecks(
        resolveConfig({
          profile: "standard",
          commands: { test_changed: "vitest related {files}" },
          gate: { scope: "changed", run_typecheck: false, require_review: false },
        }),
      ),
    ).toBe(true);
    // changed scope without a test_changed command is vacuous even with test set.
    expect(
      hasMeaningfulChecks(
        resolveConfig({
          profile: "standard",
          commands: { test: "go test ./..." },
          gate: { scope: "changed", run_typecheck: false, require_review: false },
        }),
      ),
    ).toBe(false);
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

describe("gate acceptance checks", () => {
  it("defaults to an empty list", () => {
    expect(resolveConfig({ profile: "standard" }).gate.acceptance).toEqual([]);
  });

  it("passes valid checks through resolution", () => {
    const config = resolveConfig({
      profile: "standard",
      gate: {
        acceptance: [
          { name: "api-contract", command: "./scripts/verify-api-contract.sh" },
          { name: "migration-safety", command: "./scripts/check-migrations.sh", timeout: 120 },
        ],
      },
    });
    expect(config.gate.acceptance).toEqual([
      { name: "api-contract", command: "./scripts/verify-api-contract.sh" },
      { name: "migration-safety", command: "./scripts/check-migrations.sh", timeout: 120 },
    ]);
  });

  it("rejects an empty name with a readable path", () => {
    write(
      ".opencode-dev-framework.yml",
      "profile: standard\ngate:\n  acceptance:\n    - name: ''\n      command: ./verify.sh\n",
    );
    expect(() => loadConfig(dir)).toThrowError(
      /Invalid configuration in .*gate\.acceptance\.0\.name/s,
    );
  });

  it("rejects a blank name with a readable path", () => {
    write(
      ".opencode-dev-framework.yml",
      "profile: standard\ngate:\n  acceptance:\n    - name: '   '\n      command: ./verify.sh\n",
    );
    expect(() => loadConfig(dir)).toThrowError(
      /Invalid configuration in .*gate\.acceptance\.0\.name.*must not be blank/s,
    );
  });

  it("rejects an empty command with a readable path", () => {
    write(
      ".opencode-dev-framework.yml",
      "profile: standard\ngate:\n  acceptance:\n    - name: api\n      command: ''\n",
    );
    expect(() => loadConfig(dir)).toThrowError(
      /Invalid configuration in .*gate\.acceptance\.0\.command/s,
    );
  });

  it("rejects a blank command with a readable path", () => {
    write(
      ".opencode-dev-framework.yml",
      "profile: standard\ngate:\n  acceptance:\n    - name: api\n      command: '   '\n",
    );
    expect(() => loadConfig(dir)).toThrowError(
      /Invalid configuration in .*gate\.acceptance\.0\.command.*must not be blank/s,
    );
  });

  it("rejects duplicate names naming both positions", () => {
    write(
      ".opencode-dev-framework.yml",
      "profile: standard\ngate:\n  acceptance:\n    - name: api\n      command: ./a.sh\n    - name: api\n      command: ./b.sh\n",
    );
    expect(() => loadConfig(dir)).toThrowError(
      /Invalid configuration in .*duplicate acceptance check name "api".*index 0/s,
    );
  });

  it("rejects a non-positive timeout", () => {
    write(
      ".opencode-dev-framework.yml",
      "profile: standard\ngate:\n  acceptance:\n    - name: api\n      command: ./a.sh\n      timeout: 0\n",
    );
    expect(() => loadConfig(dir)).toThrowError(
      /Invalid configuration in .*gate\.acceptance\.0\.timeout/s,
    );
  });
});
