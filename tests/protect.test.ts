import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config";
import {
  checkToolCall,
  extractCommand,
  extractFilePath,
  matchDangerousCommand,
  matchProtectedPath,
} from "../src/protect";
import type { Config } from "../src/types";

function resolve(raw: Config) {
  return resolveConfig(raw, "/project/.opencode-dev-framework.yml");
}

const PROTECT = [".env*", "go.sum", "**/vendor/**"];

describe("checkToolCall: file tools", () => {
  it("denies an edit to a protected file in strict profile", () => {
    const config = resolve({ profile: "strict", protect: PROTECT });
    const result = checkToolCall(config, "edit", { filePath: ".env" }, "/project");
    expect(result.decision).toBe("deny");
    expect(result.matchedPattern).toBe(".env*");
    expect(result.reason).toContain(".env");
  });

  it("warns on an edit to a protected file in advisory profile", () => {
    const config = resolve({ profile: "advisory", protect: PROTECT });
    const result = checkToolCall(config, "edit", { filePath: ".env.production" }, "/project");
    expect(result.decision).toBe("warn");
    expect(result.matchedPattern).toBe(".env*");
  });

  it("allows an edit to a non-protected file", () => {
    const config = resolve({ profile: "strict", protect: PROTECT });
    const result = checkToolCall(config, "edit", { filePath: "src/main.go" }, "/project");
    expect(result.decision).toBe("allow");
  });

  it("matches nested glob patterns with absolute paths", () => {
    const config = resolve({ profile: "standard", protect: PROTECT });
    const result = checkToolCall(
      config,
      "write",
      { filePath: "/project/third_party/vendor/lib/x.go" },
      "/project",
    );
    expect(result.decision).toBe("deny");
    expect(result.matchedPattern).toBe("**/vendor/**");
  });

  it("matches basename for slash-less patterns at any depth", () => {
    const config = resolve({ profile: "standard", protect: PROTECT });
    const result = checkToolCall(config, "write", { filePath: "config/.env.local" }, "/project");
    expect(result.decision).toBe("deny");
    expect(result.matchedPattern).toBe(".env*");
  });

  it("supports patch and alternative path arg keys", () => {
    const config = resolve({ profile: "standard", protect: PROTECT });
    expect(checkToolCall(config, "patch", { path: "go.sum" }, "/project").decision).toBe("deny");
  });
});

describe("checkToolCall: shell tools", () => {
  it("denies git push", () => {
    const config = resolve({ profile: "standard", protect: PROTECT });
    const result = checkToolCall(config, "bash", { command: "git push origin main" }, "/project");
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("git push");
  });

  it("denies rm -rf", () => {
    const config = resolve({ profile: "standard", protect: PROTECT });
    const result = checkToolCall(config, "bash", { command: "rm -rf build/" }, "/project");
    expect(result.decision).toBe("deny");
  });

  it("warns instead of denying in advisory profile", () => {
    const config = resolve({ profile: "advisory", protect: PROTECT });
    const result = checkToolCall(config, "bash", { command: "git push" }, "/project");
    expect(result.decision).toBe("warn");
  });

  it("allows safe commands", () => {
    const config = resolve({ profile: "strict", protect: PROTECT });
    expect(checkToolCall(config, "bash", { command: "go test ./..." }, "/project").decision).toBe(
      "allow",
    );
  });
});

describe("checkToolCall: disabled protection", () => {
  it("allows everything when the profile is off", () => {
    const config = resolveConfig({ protect: PROTECT });
    expect(config.profile).toBe("off");
    expect(checkToolCall(config, "edit", { filePath: ".env" }, "/project").decision).toBe("allow");
    expect(checkToolCall(config, "bash", { command: "git push" }, "/project").decision).toBe(
      "allow",
    );
  });

  it("allows everything when protect_off is true", () => {
    const config = resolve({ profile: "strict", protect: PROTECT, protect_off: true });
    expect(checkToolCall(config, "edit", { filePath: ".env" }, "/project").decision).toBe("allow");
    expect(checkToolCall(config, "bash", { command: "git push" }, "/project").decision).toBe(
      "allow",
    );
  });

  it("ignores unguarded tools and missing args", () => {
    const config = resolve({ profile: "strict", protect: PROTECT });
    expect(checkToolCall(config, "read", { filePath: ".env" }, "/project").decision).toBe("allow");
    expect(checkToolCall(config, "edit", {}, "/project").decision).toBe("allow");
    expect(checkToolCall(config, "bash", {}, "/project").decision).toBe("allow");
  });
});

describe("helpers", () => {
  it("extracts file paths and commands from args", () => {
    expect(extractFilePath({ filePath: "a" })).toBe("a");
    expect(extractFilePath({ path: "b" })).toBe("b");
    expect(extractFilePath({ file: "c" })).toBe("c");
    expect(extractFilePath({ nope: 1 })).toBeUndefined();
    expect(extractCommand({ command: "ls" })).toBe("ls");
    expect(extractCommand({})).toBeUndefined();
  });

  it("matches protected paths via matchProtectedPath", () => {
    const config = resolve({ profile: "standard", protect: PROTECT });
    expect(matchProtectedPath(config, "go.sum")).toBe("go.sum");
    expect(matchProtectedPath(config, "src/main.go")).toBeUndefined();
  });

  it("detects dangerous commands", () => {
    expect(matchDangerousCommand("git push origin main")?.pattern.source).toContain("git");
    expect(matchDangerousCommand("git status")).toBeUndefined();
  });

  it("does not block a path that the host permission model already denies", () => {
    const config = resolve({ profile: "standard", protect: PROTECT });
    const hostPermissions = [{ permission: "edit", pattern: "go.sum", action: "deny" }];
    const result = checkToolCall(
      config,
      "edit",
      { filePath: "go.sum" },
      undefined,
      hostPermissions,
    );
    expect(result.decision).toBe("allow");
  });

  it("does not block a shell command that the host permission model already denies", () => {
    const config = resolve({ profile: "standard" });
    const hostPermissions = [{ permission: "bash", action: "deny" }];
    const result = checkToolCall(
      config,
      "bash",
      { command: "git push" },
      undefined,
      hostPermissions,
    );
    expect(result.decision).toBe("allow");
  });
});

describe("checkToolCall: hostPermissions tolerance", () => {
  it("does not throw when hostPermissions is an OpenCode-style object", () => {
    const config = resolve({ profile: "standard", protect: [".env*"] });
    // OpenCode passes `permission` as a tool-to-mode object, not HostPermission[].
    const openCodePermission = { bash: "deny", edit: "deny", read: "allow", task: {} };
    expect(() =>
      checkToolCall(
        config,
        "write",
        { filePath: "/tmp/somefile.txt" },
        "/project",
        openCodePermission as unknown as HostPermission[],
      ),
    ).not.toThrow();
  });

  it("does not throw (and allows) when hostPermissions is an empty object", () => {
    const config = resolve({ profile: "standard", protect: [".env*"] });
    const result = checkToolCall(
      config,
      "write",
      { filePath: "/tmp/somefile.txt" },
      "/project",
      {} as unknown as HostPermission[],
    );
    expect(result.decision).toBe("allow");
  });

  it("does not throw when hostPermissions is an unexpected (non-array) value", () => {
    const config = resolve({ profile: "standard", protect: [".env*"] });
    expect(() =>
      checkToolCall(
        config,
        "bash",
        { command: "ls" },
        "/project",
        "deny" as unknown as HostPermission[],
      ),
    ).not.toThrow();
  });

  it("still guards protected paths even when hostPermissions is a non-array", () => {
    const config = resolve({ profile: "standard", protect: [".env*"] });
    const result = checkToolCall(
      config,
      "write",
      { filePath: ".env" },
      "/project",
      {} as unknown as HostPermission[],
    );
    expect(result.decision).toBe("deny");
  });
});
