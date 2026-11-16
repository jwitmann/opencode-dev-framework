import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractDshCommand, extractDshPaths } from "../src/adapters/dsh/extract";
import {
  apply,
  type DshContext,
  type DshPreDecision,
  guardErrorDecision,
} from "../src/adapters/dsh/index";
import { clearConfigCache, loadConfig } from "../src/core/config";
import { checkToolCall, decideFileGuard, decideShellGuard } from "../src/core/protect";

function writeConfig(directory: string, body: string): void {
  writeFileSync(join(directory, ".opencode-dev-framework.yml"), body);
}

interface Captured {
  pre: (
    exec: { name: string; arguments?: unknown },
    next: () => Promise<DshPreDecision>,
  ) => Promise<DshPreDecision>;
  post:
    | ((
        exec: { name: string; arguments?: unknown },
        result: { isError: boolean },
        next: () => Promise<{ kind: string }>,
      ) => Promise<{ kind: string; additionalContexts?: unknown }>)
    | undefined;
  stopping:
    | ((payload: {
        agent: { steer?: (m: unknown) => void; followup?: (m: unknown) => void };
        turn: unknown;
      }) => Promise<void> | void)
    | undefined;
  registered: Array<{ name: string; description: string; handler: () => unknown }>;
  warns: string[];
}

function stubContext(): { ctx: DshContext; captured: Captured; spawned: string[][] } {
  const captured = {
    pre: undefined,
    post: undefined,
    stopping: undefined,
    registered: [],
    warns: [],
  } as unknown as Captured;
  const spawned: string[][] = [];
  const ctx = {
    subprocess: {
      spawn: (spec: { argv: string[] }) => {
        spawned.push(spec.argv);
        return {
          done: Promise.resolve({ exitCode: 0, signal: null }),
          collected: {
            stdout: { readFrom: () => ({ text: "" }) },
            stderr: { readFrom: () => ({ text: "" }) },
          },
        };
      },
    },
    logger: {
      info: vi.fn(),
      warn: (message: string) => {
        captured.warns.push(message);
      },
      error: vi.fn(),
      debug: vi.fn(),
    },
    commands: {
      register: (def: { name: string; description: string; handler: () => unknown }) => {
        captured.registered.push(def);
      },
    },
    on: (event: string, listener: never) => {
      if (event === "tools/pre-execute") captured.pre = listener as never;
      if (event === "tools/post-execute") captured.post = listener as never;
      if (event === "agent/turn-stopping") captured.stopping = listener as never;
    },
  } as unknown as DshContext;
  return { ctx, captured, spawned };
}

describe("DSH envelope extraction", () => {
  it("reads snake_case file_path for write/edit", () => {
    expect(extractDshPaths({ name: "write", arguments: { file_path: "a.ts" } })).toEqual(["a.ts"]);
    expect(extractDshPaths({ name: "edit", arguments: { file_path: "b.ts" } })).toEqual(["b.ts"]);
  });

  it("falls back to core camelCase keys", () => {
    expect(extractDshPaths({ name: "edit", arguments: { filePath: "c.ts" } })).toEqual(["c.ts"]);
  });

  it("parses apply_patch headers", () => {
    const input = "*** Begin Patch\n*** Add File: new.ts\n+hi\n*** End Patch";
    expect(extractDshPaths({ name: "apply_patch", arguments: { input } })).toEqual(["new.ts"]);
  });

  it("returns [] for unrecognized envelopes", () => {
    expect(extractDshPaths({ name: "read", arguments: { file_path: "a.ts" } })).toEqual([]);
    expect(extractDshPaths({ name: "apply_patch", arguments: { input: "no headers" } })).toEqual(
      [],
    );
  });

  it("extracts shell commands only for bash/shell", () => {
    expect(extractDshCommand({ name: "bash", arguments: { command: "ls" } })).toBe("ls");
    expect(extractDshCommand({ name: "write", arguments: { command: "ls" } })).toBeUndefined();
  });
});

describe("core guard seam (plan 25 slice 4)", () => {
  it("decideFileGuard uses core reason text", () => {
    const directory = mkdtempSync(join(tmpdir(), "odf-seam-"));
    try {
      writeConfig(directory, `profile: standard\nprotect:\n  - ".env*"\n`);
      const config = loadConfig(directory);
      const verdict = decideFileGuard(config, ".env", directory);
      expect(verdict.decision).toBe("deny");
      expect(verdict.reason).toContain('matched ".env*"');
      expect(verdict.reason).toContain("edit on protected path");
    } finally {
      clearConfigCache();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("checkToolCall delegates to the seam with identical verdicts (one logic)", () => {
    const directory = mkdtempSync(join(tmpdir(), "odf-seam-"));
    try {
      writeConfig(directory, `profile: standard\nprotect:\n  - ".env*"\n`);
      const config = loadConfig(directory);
      for (const tool of ["edit", "write", "patch"]) {
        expect(checkToolCall(config, tool, { filePath: ".env" }, directory)).toEqual(
          decideFileGuard(config, ".env", directory, undefined, tool),
        );
      }
      expect(checkToolCall(config, "bash", { command: "rm -rf /tmp/x" }, directory)).toEqual(
        decideShellGuard(config, "rm -rf /tmp/x", undefined, "bash"),
      );
    } finally {
      clearConfigCache();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("decideShellGuard blocks dangerous commands and honors off", () => {
    const directory = mkdtempSync(join(tmpdir(), "odf-seam-"));
    try {
      writeConfig(directory, "profile: standard\n");
      const config = loadConfig(directory);
      expect(decideShellGuard(config, "rm -rf /tmp/x").decision).toBe("deny");
      expect(decideShellGuard({ ...config, profile: "off" }, "rm -rf /tmp/x").decision).toBe(
        "allow",
      );
      expect(decideShellGuard({ ...config, protect_off: true }, "rm -rf /tmp/x").decision).toBe(
        "allow",
      );
    } finally {
      clearConfigCache();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("warn mode maps to ask via the adapter", () => {
    const directory = mkdtempSync(join(tmpdir(), "odf-seam-"));
    try {
      writeConfig(directory, "profile: advisory\n");
      const config = loadConfig(directory);
      expect(decideShellGuard(config, "rm -rf /tmp/x").decision).toBe("warn");
    } finally {
      clearConfigCache();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("DSH adapter (plan 25 slice 4)", () => {
  let directory: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "odf-dsh-"));
    savedEnv = process.env["ODF_WORKDIR"];
    process.env["ODF_WORKDIR"] = directory;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env["ODF_WORKDIR"];
    } else {
      process.env["ODF_WORKDIR"] = savedEnv;
    }
    clearConfigCache();
    rmSync(directory, { recursive: true, force: true });
  });

  it("denies rm -rf with the core reason and denies .env writes", async () => {
    writeConfig(directory, 'profile: standard\nprotect:\n  - ".env*"\n');
    const { ctx, captured } = stubContext();
    apply(ctx);
    const next = async (): Promise<DshPreDecision> => ({ kind: "allow" });
    const bash = await captured.pre(
      { name: "bash", arguments: { command: "rm -rf /tmp/x" } },
      next,
    );
    expect(bash.kind).toBe("deny");
    expect((bash as { reason: string }).reason).toContain("recursive force delete");
    const env = await captured.pre({ name: "write", arguments: { file_path: ".env" } }, next);
    expect(env.kind).toBe("deny");
    expect((env as { reason: string }).reason).toContain('matched ".env*"');
    const ok = await captured.pre({ name: "write", arguments: { file_path: "src/app.ts" } }, next);
    expect(ok).toEqual({ kind: "allow" });
  });

  it("never blocks on warn: advisory allows with a warn log", async () => {
    writeConfig(directory, 'profile: advisory\nprotect:\n  - ".env*"\n');
    const { ctx, captured } = stubContext();
    apply(ctx);
    const next = async (): Promise<DshPreDecision> => ({ kind: "allow" });
    // `ask` is never emitted: without an approval service the host denies
    // it, which would convert warnings into blocks. Warn allows, like opencode.
    const bash = await captured.pre(
      { name: "bash", arguments: { command: "rm -rf /tmp/x" } },
      next,
    );
    expect(bash).toEqual({ kind: "allow" });
    const env = await captured.pre({ name: "write", arguments: { file_path: ".env" } }, next);
    expect(env).toEqual({ kind: "allow" });
    expect(captured.warns.length).toBeGreaterThan(0);
  });

  it("guardErrorDecision fails closed except in advisory", () => {
    expect(guardErrorDecision("advisory")).toBe("allow");
    expect(guardErrorDecision("standard")).toBe("deny");
    expect(guardErrorDecision("strict")).toBe("deny");
  });

  it("enforces pre-flight tasks before guardrails", async () => {
    writeConfig(directory, 'profile: standard\npreflight:\n  - "Do the thing"\n');
    const { ctx, captured } = stubContext();
    apply(ctx);
    const next = async (): Promise<DshPreDecision> => ({ kind: "allow" });
    const blocked = await captured.pre(
      { name: "write", arguments: { file_path: "work.ts" } },
      next,
    );
    expect(blocked.kind).toBe("deny");
    expect((blocked as { reason: string }).reason).toContain("pre-flight");
    // The artifact itself stays writable so the session can comply.
    const artifact = await captured.pre(
      {
        name: "write",
        arguments: { file_path: ".opencode/opencode-dev-framework/preflight.md" },
      },
      next,
    );
    expect(artifact).toEqual({ kind: "allow" });
    // Completing the artifact stand downs the duty.
    mkdirSync(join(directory, ".opencode", "opencode-dev-framework"), { recursive: true });
    writeFileSync(
      join(directory, ".opencode", "opencode-dev-framework", "preflight.md"),
      "# Preflight\n\n- [x] Do the thing\n",
    );
    const allowed = await captured.pre(
      { name: "write", arguments: { file_path: "work.ts" } },
      next,
    );
    expect(allowed).toEqual({ kind: "allow" });
  });

  it("pre-flight warns and continues in advisory", async () => {
    writeConfig(directory, 'profile: advisory\npreflight:\n  - "Do the thing"\n');
    const { ctx, captured } = stubContext();
    apply(ctx);
    const next = async (): Promise<DshPreDecision> => ({ kind: "allow" });
    const decision = await captured.pre(
      { name: "write", arguments: { file_path: "work.ts" } },
      next,
    );
    expect(decision).toEqual({ kind: "allow" });
    expect(captured.warns.length).toBeGreaterThan(0);
  });

  it("apply with a broken config logs and registers nothing (never throws)", () => {
    writeFileSync(join(directory, ".opencode-dev-framework.yml"), "{{{{ not yaml }\n");
    const { ctx, captured } = stubContext();
    expect(() => apply(ctx)).not.toThrow();
    expect(captured.pre).toBeUndefined();
    expect(captured.post).toBeUndefined();
    expect(captured.stopping).toBeUndefined();
  });

  it("no-ops every hook when the kill switch is set", async () => {
    writeConfig(directory, "profile: off\n");
    const { ctx, captured } = stubContext();
    apply(ctx);
    const next = async (): Promise<DshPreDecision> => ({ kind: "allow" });
    expect(
      await captured.pre({ name: "bash", arguments: { command: "rm -rf /tmp/x" } }, next),
    ).toEqual({
      kind: "allow",
    });
    const postNext = async () => ({ kind: "accept" as const });
    expect(
      await captured.post?.(
        { name: "write", arguments: { file_path: "a.ts" } },
        { isError: false },
        postNext,
      ),
    ).toEqual({ kind: "accept" });
  });

  it("format-then-lint reports via additionalContexts and tracks the file", async () => {
    writeConfig(
      directory,
      'profile: standard\ncommands:\n  lint:\n    ".ts": "echo lint {file}"\n  format:\n    ".ts": "echo format {file}"\non_edit:\n  format: true\n  lint: true\n',
    );
    writeFileSync(join(directory, "greet.ts"), "export const x = 1;\n");
    const { ctx, captured, spawned } = stubContext();
    apply(ctx);
    const postNext = async () => ({ kind: "accept" as const });
    const decision = await captured.post?.(
      { name: "write", arguments: { file_path: "greet.ts" } },
      { isError: false },
      postNext,
    );
    expect(decision?.kind).toBe("accept");
    const contexts = (
      decision as { additionalContexts?: Array<{ content: Array<{ text: string }> }> }
    ).additionalContexts;
    expect(contexts?.length).toBe(1);
    expect(contexts?.[0].content[0].text).toContain("format passed for greet.ts");
    expect(contexts?.[0].content[0].text).toContain("lint passed for greet.ts");
    // Format ran before lint (formatter rewrites must land first).
    expect(spawned[0].join(" ")).toContain("format");
    expect(spawned[1].join(" ")).toContain("lint");
  });

  it("turn-stopping steers on a blocked gate and stays silent on pass", async () => {
    writeConfig(directory, "profile: standard\n");
    const { ctx, captured } = stubContext();
    apply(ctx);
    // No changed files: gate skips, verdict passes, no steer.
    const quiet = { steer: vi.fn(), followup: vi.fn() };
    await captured.stopping?.({ agent: quiet, turn: 1 });
    expect(quiet.steer).not.toHaveBeenCalled();
    expect(quiet.followup).not.toHaveBeenCalled();
    // Track a file via post-execute (no review artifact on disk): the review
    // requirement blocks and the agent is steered back with the summary.
    writeFileSync(join(directory, "work.ts"), "export const y = 2;\n");
    const postNext = async () => ({ kind: "accept" as const });
    await captured.post?.(
      { name: "write", arguments: { file_path: "work.ts" } },
      { isError: false },
      postNext,
    );
    const steered = { steer: vi.fn(), followup: vi.fn() };
    await captured.stopping?.({ agent: steered, turn: 1 });
    expect(steered.steer).toHaveBeenCalledTimes(1);
  });

  it("failed writes still track (gate sees partial applies)", async () => {
    writeConfig(directory, "profile: standard\n");
    writeFileSync(join(directory, "half.ts"), "export const z = 3;\n");
    const { ctx, captured } = stubContext();
    apply(ctx);
    const postNext = async () => ({ kind: "accept" as const });
    // Error status: no format/lint, no contexts — but the file is tracked,
    // so the next turn-stopping gate blocks on the missing review.
    const decision = await captured.post?.(
      { name: "write", arguments: { file_path: "half.ts" } },
      { isError: true },
      postNext,
    );
    expect(decision).toEqual({ kind: "accept" });
    const steered = { steer: vi.fn(), followup: vi.fn() };
    await captured.stopping?.({ agent: steered, turn: 1 });
    expect(steered.steer).toHaveBeenCalledTimes(1);
  });

  it("unconfigured file types pass through silently (no skip-noise)", async () => {
    writeConfig(directory, "profile: standard\n");
    writeFileSync(join(directory, "notes.txt"), "plain text\n");
    const { ctx, captured, spawned } = stubContext();
    apply(ctx);
    const postNext = async () => ({ kind: "accept" as const });
    const decision = await captured.post?.(
      { name: "write", arguments: { file_path: "notes.txt" } },
      { isError: false },
      postNext,
    );
    // No lint/format command for .txt: clean passthrough, no subprocess,
    // no agent-visible contexts.
    expect(decision).toEqual({ kind: "accept" });
    expect(spawned).toEqual([]);
  });

  it("turn-stopping stays silent when the kill switch is set", async () => {
    writeConfig(directory, "profile: off\n");
    const { ctx, captured } = stubContext();
    apply(ctx);
    const agent = { steer: vi.fn(), followup: vi.fn() };
    await captured.stopping?.({ agent, turn: 1 });
    expect(agent.steer).not.toHaveBeenCalled();
    expect(agent.followup).not.toHaveBeenCalled();
  });

  it("registers odf-status via dsh-commands", async () => {
    writeConfig(directory, "profile: standard\n");
    const { ctx, captured } = stubContext();
    apply(ctx);
    expect(captured.registered.map((r) => r.name)).toContain("odf-status");
  });
});
