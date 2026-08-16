import { describe, expect, it } from "vitest";
import { normalizeCommandMap, splitCommand } from "../src/command-utils";

describe("splitCommand", () => {
  it("splits a simple command into tokens", () => {
    expect(splitCommand("go test ./...")).toEqual(["go", "test", "./..."]);
  });

  it("honors double quotes", () => {
    expect(splitCommand('echo "hello world"')).toEqual(["echo", "hello world"]);
  });

  it("honors single quotes", () => {
    expect(splitCommand("echo 'hello world'")).toEqual(["echo", "hello world"]);
  });

  it("returns an empty array for empty input", () => {
    expect(splitCommand("")).toEqual([]);
  });
});

describe("normalizeCommandMap", () => {
  it("turns a string into a default command", () => {
    const result = normalizeCommandMap("eslint {file}");
    expect(result.default).toBe("eslint {file}");
    expect(result.byExtension).toEqual({});
  });

  it("keeps per-extension entries", () => {
    const result = normalizeCommandMap({ ".go": "golangci-lint run {file}" });
    expect(result.default).toBeUndefined();
    expect(result.byExtension).toEqual({ ".go": "golangci-lint run {file}" });
  });

  it("treats a 'default' key as the fallback command", () => {
    const result = normalizeCommandMap({
      default: "eslint {file}",
      ".go": "golangci-lint run {file}",
    });
    expect(result.default).toBe("eslint {file}");
    expect(result.byExtension).toEqual({ ".go": "golangci-lint run {file}" });
  });

  it("returns an empty map for undefined", () => {
    const result = normalizeCommandMap(undefined);
    expect(result.default).toBeUndefined();
    expect(result.byExtension).toEqual({});
  });
});
