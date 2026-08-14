import { describe, expect, it } from "vitest";
import {
  generateFormatter,
  generatePermission,
  normalizeCommandMap,
  splitCommand,
  toOpenCodeFragments,
} from "../src/config-to-opencode";
import { resolveConfig } from "../src/config";
import type { Config } from "../src/types";

function resolve(raw: Config) {
  return resolveConfig(raw, "/project/.opencode-dev-framework.yml");
}

describe("generatePermission", () => {
  it("generates deny rules for protected paths in deny mode", () => {
    const config = resolve({ profile: "standard", protect: [".env*", "go.sum"] });
    expect(generatePermission(config)).toEqual({
      edit: {
        "*": "allow",
        ".env*": "deny",
        "go.sum": "deny",
      },
    });
  });

  it("emits nothing in warn mode (native permission has no warn action)", () => {
    const config = resolve({ profile: "advisory", protect: [".env*"] });
    expect(generatePermission(config)).toEqual({});
  });

  it("emits nothing when protection is disabled", () => {
    const config = resolve({ profile: "standard", protect: [".env*"], protect_off: true });
    expect(generatePermission(config)).toEqual({});
  });
});

describe("generateFormatter", () => {
  it("generates formatter rules per extension", () => {
    const config = resolve({
      profile: "standard",
      commands: { format: { ".go": "gofumpt -w {file}", ".py": "ruff format {file}" } },
    });
    const formatter = generateFormatter(config);
    expect(formatter["dev-framework-format-go"]).toEqual({
      command: ["gofumpt", "-w", "$FILE"],
      extensions: [".go"],
    });
    expect(formatter["dev-framework-format-py"]).toEqual({
      command: ["ruff", "format", "$FILE"],
      extensions: [".py"],
    });
  });

  it("generates an unscoped formatter for a plain string command", () => {
    const config = resolve({
      profile: "standard",
      commands: { format: "biome format --write {file}" },
    });
    const formatter = generateFormatter(config);
    expect(formatter["dev-framework-format"]).toEqual({
      command: ["biome", "format", "--write", "$FILE"],
    });
  });

  it("returns an empty fragment when no format command is configured", () => {
    expect(generateFormatter(resolve({ profile: "standard" }))).toEqual({});
  });
});

describe("helpers", () => {
  it("splits commands honoring quotes", () => {
    expect(splitCommand('echo "hello world" {file}')).toEqual(["echo", "hello world", "{file}"]);
  });

  it("normalizes command maps", () => {
    expect(normalizeCommandMap("x {file}")).toEqual({ default: "x {file}", byExtension: {} });
    expect(normalizeCommandMap({ ".go": "gofumpt {file}" })).toEqual({
      byExtension: { ".go": "gofumpt {file}" },
    });
    expect(normalizeCommandMap(undefined)).toEqual({ byExtension: {} });
  });
});

describe("toOpenCodeFragments", () => {
  it("combines permission and formatter fragments, omitting empties", () => {
    const config = resolve({
      profile: "standard",
      protect: ["go.sum"],
      commands: { format: { ".go": "gofumpt -w {file}" } },
    });
    const fragments = toOpenCodeFragments(config);
    expect(fragments.permission?.edit?.["go.sum"]).toBe("deny");
    expect(Object.keys(fragments.formatter ?? {})).toEqual(["dev-framework-format-go"]);
  });

  it("returns an empty object for an off profile", () => {
    expect(toOpenCodeFragments(resolveConfig({}))).toEqual({});
  });
});
