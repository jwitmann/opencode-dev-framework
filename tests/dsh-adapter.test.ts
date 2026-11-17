import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractDshCommand, extractDshPaths } from "../src/adapters/dsh/extract";
import {
  apply,
  type DshContext,
  type DshPostDecision,
  type DshPreDecision,
  guardErrorDecision,
  isChildAgent,
  lintBlockLines,
} from "../src/adapters/dsh/index";
import { clearConfigCache, loadConfig } from "../src/core/config";
import type { LintOutcome } from "../src/core/lint";
import { checkToolCall, decideFileGuard, decideShellGuard } from "../src/core/protect";

function writeConfig(directory: string, body: string): void {
  writeFileSync(join(directory, ".opencode-dev-framework.yml"), body);
}

interface Captured {
  pre: (
    exec: {
      name: string;
      arguments?: unknown;
      agent?: {
        session?: { header?: { origin?: unknown; parentSession?: unknown } };
      };
    },
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
        agent: {
          steer?: (m: unknown) => void;
          followup?: (m: unknown) => void;
          session?: { header?: { origin?: unknown; parentSession?: unknown } };
        };
        turn: unknown;
        signal?: AbortSignal;
      }) => Promise<void> | void)
    | undefined;
  preStep:
    | ((
        payload: {
          agent: { steer?: (m: unknown) => void; followup?: (m: unknown) => void };
          messages: unknown[];
          turn: unknown;
          step?: unknown;
          signal?: AbortSignal;
        },
        next: () => Promise<unknown>,
      ) => Promise<unknown>)
    | undefined;
  registered: Array<{
    name: string;
    description: string;
    handler: (invocation?: { agent?: unknown; rawInput?: string; signal?: AbortSignal }) => unknown;
  }>;
  goalsCreated: Array<{ objective: string }>;
  commandNames: string[] | undefined;
  tools: Array<{
    name: string;
    description: string;
    parameters: unknown;
    output: unknown;
    isConcurrencySafe?: (args: unknown) => boolean;
    execute: (args: unknown, exec: unknown) => Promise<unknown>;
  }>;
  warns: string[];
}

function stubContext(
  spawn?: { exitCode?: number; stdout?: string; stderr?: string },
  commandNames: string[] | undefined = ["goal"],
): {
  ctx: DshContext;
  captured: Captured;
  spawned: string[][];
} {
  const captured = {
    pre: undefined,
    post: undefined,
    stopping: undefined,
    registered: [],
    warns: [],
    goalsCreated: [],
    tools: [],
    commandNames,
  } as unknown as Captured;
  const spawned: string[][] = [];
  const ctx = {
    subprocess: {
      spawn: (spec: { argv: string[] }) => {
        spawned.push(spec.argv);
        return {
          done: Promise.resolve({ exitCode: spawn?.exitCode ?? 0, signal: null }),
          collected: {
            stdout: { readFrom: () => ({ text: spawn?.stdout ?? "" }) },
            stderr: { readFrom: () => ({ text: spawn?.stderr ?? "" }) },
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
      list: async () => (captured.commandNames ?? []).map((name) => ({ name })),
    },
    tools: {
      register: (def: {
        name: string;
        description: string;
        parameters: unknown;
        output: unknown;
        isConcurrencySafe?: (args: unknown) => boolean;
        execute: (args: unknown, exec: unknown) => Promise<unknown>;
      }) => {
        captured.tools.push(def);
      },
    },
    goals: {
      create: (agent: unknown, request: { objective: string }) => {
        captured.goalsCreated.push(request);
        return { id: "goal-1" };
      },
    },
    on: (event: string, listener: never) => {
      if (event === "tools/pre-execute") captured.pre = listener as never;
      if (event === "tools/post-execute") captured.post = listener as never;
      if (event === "agent/turn-stopping") captured.stopping = listener as never;
      if (event === "agent/pre-step") captured.preStep = listener as never;
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

  it("core seam still reports warn (adapter never blocks on it)", () => {
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

  const userMessage = {
    role: "user",
    content: [{ type: "text", text: "do the thing" }],
    source: { kind: "user" },
  };

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
    // Denials carry a structured identity for host diagnostics.
    expect((bash as { info?: { name: string; code: string } }).info).toEqual({
      name: "opencode-dev-framework",
      code: "guard-deny",
    });
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
    expect((blocked as { info?: { name: string; code: string } }).info).toEqual({
      name: "opencode-dev-framework",
      code: "preflight-deny",
    });
    // The artifact itself stays writable so the session can comply.
    const artifactDecision = await captured.pre(
      {
        name: "write",
        arguments: { file_path: ".opencode/opencode-dev-framework/preflight.md" },
      },
      next,
    );
    expect(artifactDecision).toEqual({ kind: "allow" });
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

  it("enforces pre-flight on apply_patch envelopes too", async () => {
    writeConfig(directory, 'profile: standard\npreflight:\n  - "Do the thing"\n');
    const { ctx, captured } = stubContext();
    apply(ctx);
    const next = async (): Promise<DshPreDecision> => ({ kind: "allow" });
    const blocked = await captured.pre(
      {
        name: "apply_patch",
        arguments: { input: "*** Update File: src/old.ts\n@@ -1 +1 @@\n-old\n+new\n" },
      },
      next,
    );
    expect(blocked.kind).toBe("deny");
    expect((blocked as { reason: string }).reason).toContain("pre-flight");
  });

  it("protect_off stands down guards but not lint or the gate", async () => {
    writeConfig(
      directory,
      'profile: standard\nprotect_off: true\nprotect:\n  - ".env*"\n' +
        'commands:\n  lint:\n    ".ts": "echo lint {file}"\n',
    );
    writeFileSync(join(directory, "work.ts"), "export const y = 2;\n");
    const { ctx, captured, spawned } = stubContext();
    apply(ctx);
    const next = async (): Promise<DshPreDecision> => ({ kind: "allow" });
    // Guards stand down: protected write allowed.
    const allowed = await captured.pre({ name: "write", arguments: { file_path: ".env" } }, next);
    expect(allowed).toEqual({ kind: "allow" });
    // But per-edit lint still runs on the next write.
    const postNext = async () => ({ kind: "accept" as const });
    const decision = await captured.post?.(
      { name: "write", arguments: { file_path: "work.ts" } },
      { isError: false },
      postNext,
    );
    expect(decision?.kind).toBe("accept");
    expect(spawned.length).toBeGreaterThan(0);
    // And the turn-stopping gate still fires (missing review blocks).
    const steered = { steer: vi.fn(), followup: vi.fn() };
    await captured.stopping?.({ agent: steered, turn: 1 });
    expect(steered.steer).toHaveBeenCalledTimes(1);
  });

  it("isChildAgent reads the host header: subagent origin plus creator only", () => {
    expect(
      isChildAgent({ session: { header: { origin: "subagent", parentSession: "ses-parent" } } }),
    ).toBe(true);
    expect(isChildAgent({})).toBe(false);
    expect(isChildAgent(undefined)).toBe(false);
    // Historical ordinary forks may retain a creator id without the
    // subagent origin: those read as top-level (host classification).
    expect(isChildAgent({ session: { header: { parentSession: "ses-parent" } } })).toBe(false);
    expect(isChildAgent({ session: { header: { origin: "subagent" } } })).toBe(false);
    expect(isChildAgent({ session: { header: { origin: "subagent", parentSession: "" } } })).toBe(
      false,
    );
  });

  it("turn-stopping skips child sessions: no steer, no followup", async () => {
    writeConfig(directory, "profile: standard\n");
    writeFileSync(join(directory, "work.ts"), "export const y = 2;\n");
    const { ctx, captured } = stubContext();
    apply(ctx);
    // Seed gate duty: track an edit so the missing review blocks.
    const postNext = async () => ({ kind: "accept" as const });
    await captured.post?.(
      { name: "write", arguments: { file_path: "work.ts" } },
      { isError: false },
      postNext,
    );
    // Sanity: a top-level agent on the same dirty tree IS steered.
    const plain = { steer: vi.fn(), followup: vi.fn() };
    await captured.stopping?.({ agent: plain, turn: 2 });
    expect(plain.steer).toHaveBeenCalledTimes(1);
    const child = {
      steer: vi.fn(),
      followup: vi.fn(),
      session: { header: { origin: "subagent", parentSession: "ses-parent" } },
    };
    await captured.stopping?.({ agent: child, turn: 1 });
    expect(child.steer).not.toHaveBeenCalled();
    expect(child.followup).not.toHaveBeenCalled();
  });

  it("pre-execute denies child review-artifact writes, allows the parent's", async () => {
    writeConfig(directory, "profile: standard\n");
    const { ctx, captured } = stubContext();
    apply(ctx);
    const next = async (): Promise<DshPreDecision> => ({ kind: "allow" });
    const artifact = ".opencode/opencode-dev-framework/review.md";
    const child = { session: { header: { origin: "subagent", parentSession: "ses-parent" } } };
    const denied = await captured.pre(
      { name: "write", arguments: { file_path: artifact }, agent: child },
      next,
    );
    expect(denied.kind).toBe("deny");
    expect((denied as { reason: string }).reason).toContain("child sessions never write");
    expect((denied as { info?: { code: string } }).info?.code).toBe("child-artifact-deny");
    // Top-level owes the duty: its own artifact write passes through.
    const parent = await captured.pre({ name: "write", arguments: { file_path: artifact } }, next);
    expect(parent).toEqual({ kind: "allow" });
    // A shell redirect to the artifact is a write too.
    const redirect = await captured.pre(
      { name: "bash", arguments: { command: `echo hi > ${artifact}` }, agent: child },
      next,
    );
    expect(redirect.kind).toBe("deny");
  });

  it("child artifact guard warns and continues in advisory", async () => {
    writeConfig(directory, "profile: advisory\n");
    const { ctx, captured } = stubContext();
    apply(ctx);
    const next = async (): Promise<DshPreDecision> => ({ kind: "allow" });
    const child = { session: { header: { origin: "subagent", parentSession: "ses-parent" } } };
    const decision = await captured.pre(
      {
        name: "write",
        arguments: { file_path: ".opencode/opencode-dev-framework/review.md" },
        agent: child,
      },
      next,
    );
    expect(decision).toEqual({ kind: "allow" });
    expect(captured.warns.some((w) => w.includes("child sessions never write"))).toBe(true);
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
    // The df-status command below the early return never registers either.
    expect(captured.registered).toEqual([]);
  });

  it("registers agent tools with the service receiver preserved", () => {
    writeConfig(directory, "profile: standard\n");
    const { ctx, captured } = stubContext();
    // The host implementation reads `this`: an unbound register call
    // throws and every tool silently never registers (live-proven S1
    // failure mode — gates fired, catalog empty). The stub enforces it.
    const toolsService = {
      register(this: unknown, def: { name: string }) {
        if (this !== toolsService) {
          throw new TypeError("register called without service receiver");
        }
        captured.tools.push(def as never);
      },
    };
    const bound = { ...ctx, tools: toolsService };
    expect(() => apply(bound as unknown as DshContext)).not.toThrow();
    expect(captured.tools.map((t) => t.name)).toEqual([
      "dev_framework_verify",
      "dev_framework_set_profile",
      "dev_framework_status",
      "dev_framework_init",
    ]);
  });

  it("survives a host that throws on uninjected service reads", async () => {
    writeConfig(directory, "profile: standard\n");
    const { ctx, captured } = stubContext();
    // The host throws on reading a non-injected service instead of
    // yielding undefined: the adapter must degrade to warn+skip, never
    // take the gates down with it.
    const hardened = new Proxy(ctx, {
      get: (target, prop) => {
        if (prop === "tools" || prop === "goals") {
          throw new Error(`cannot get property "${String(prop)}" without inject`);
        }
        return Reflect.get(target as object, prop);
      },
    });
    expect(() => apply(hardened as unknown as DshContext)).not.toThrow();
    expect(captured.registered.map((r) => r.name)).toContain("df-status");
    expect(captured.tools).toEqual([]);
    expect(captured.warns.some((w) => w.includes("tool service unavailable"))).toBe(true);
    // Gates still fire without the tool service.
    const next = async (): Promise<DshPreDecision> => ({ kind: "allow" });
    const decision = await captured.pre({ name: "write", arguments: { file_path: ".env" } }, next);
    expect(decision.kind).toBe("deny");
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

  it("blocks the tool call on lint findings in standard (model-facing feedback)", async () => {
    writeConfig(
      directory,
      'profile: standard\ncommands:\n  lint:\n    ".ts": "echo LINT-BROKEN {file}; exit 1"\non_edit:\n  format: false\n  lint: true\n',
    );
    writeFileSync(join(directory, "bad.ts"), "export const x: number = 'nope';\n");
    const { ctx, captured } = stubContext({ exitCode: 1, stdout: "LINT-BROKEN bad.ts" });
    apply(ctx);
    const postNext = async () => ({ kind: "accept" as const });
    const decision = (await captured.post?.(
      { name: "write", arguments: { file_path: "bad.ts" } },
      { isError: false },
      postNext,
    )) as DshPostDecision | undefined;
    expect(decision?.kind).toBe("block");
    const blocked = decision as Extract<DshPostDecision, { kind: "block" }>;
    expect(blocked.feedback[0].text).toContain("LINT-BROKEN bad.ts");
    expect(blocked.feedback[0].text).toContain("bad.ts");
    expect(blocked.info).toEqual({ name: "opencode-dev-framework", code: "lint-block" });
    // The file is still tracked: the gate sees the edit even though the
    // tool call failed, so the agent cannot sail past via the block itself.
    const steered = { steer: vi.fn(), followup: vi.fn() };
    await captured.stopping?.({ agent: steered, turn: 1 });
    expect(steered.steer).toHaveBeenCalledTimes(1);
  });

  it("never blocks post-execute in advisory (accepts with contexts)", async () => {
    writeConfig(
      directory,
      'profile: advisory\ncommands:\n  lint:\n    ".ts": "echo LINT-BROKEN {file}; exit 1"\non_edit:\n  format: false\n  lint: true\n',
    );
    writeFileSync(join(directory, "bad.ts"), "export const x = 1;\n");
    const { ctx, captured } = stubContext({ exitCode: 1, stdout: "LINT-BROKEN bad.ts" });
    apply(ctx);
    const postNext = async () => ({ kind: "accept" as const });
    const decision = await captured.post?.(
      { name: "write", arguments: { file_path: "bad.ts" } },
      { isError: false },
      postNext,
    );
    expect(decision?.kind).toBe("accept");
    expect(
      (decision as { additionalContexts?: Array<{ content: Array<{ text: string }> }> })
        .additionalContexts?.[0].content[0].text,
    ).toContain("lint failed for bad.ts");
    expect(captured.warns.length).toBe(0);
  });

  it("lintBlockLines blames findings, excuses timeouts/skips/infra", () => {
    const finding: LintOutcome = {
      skipped: false,
      filePath: "a.ts",
      command: ["eslint", "a.ts"],
      result: { stdout: "no-unused-vars", stderr: "", exitCode: 1, timedOut: false },
    };
    const lines = lintBlockLines([finding]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("lint failed for a.ts (exit 1)");
    expect(lines[0]).toContain("no-unused-vars");
    // Timeouts are infra unknowns, not model faults — never block lines.
    expect(
      lintBlockLines([
        {
          skipped: false,
          filePath: "b.ts",
          result: { stdout: "", stderr: "", exitCode: 1, timedOut: true },
        },
      ]),
    ).toEqual([]);
    // Skips, passes, timeouts, 127s, and silent nonzero exits stay silent:
    // timeouts are infra unknowns; 127 is the command-not-found convention
    // (the linter never ran); a nonzero exit with no output anywhere is
    // infra noise, not evidence of findings.
    expect(lintBlockLines([{ skipped: true, filePath: "c.ts", reason: "ghost" }])).toEqual([]);
    expect(
      lintBlockLines([
        {
          skipped: false,
          filePath: "d.ts",
          result: { stdout: "", stderr: "", exitCode: 0, timedOut: false },
        },
      ]),
    ).toEqual([]);
    expect(
      lintBlockLines([
        {
          skipped: false,
          filePath: "e.ts",
          result: { stdout: "", stderr: "", exitCode: 2, timedOut: false },
        },
      ]),
    ).toEqual([]);
    expect(
      lintBlockLines([
        {
          skipped: false,
          filePath: "missing.ts",
          result: { stdout: "", stderr: "spawn eslint ENOENT", exitCode: 127, timedOut: false },
        },
      ]),
    ).toEqual([]);
    // Long linter output is capped, not dumped unbounded into context.
    const long = lintBlockLines([
      {
        skipped: false,
        filePath: "f.ts",
        result: { stdout: "x".repeat(5000), stderr: "", exitCode: 1, timedOut: false },
      },
    ]);
    expect(long).toHaveLength(1);
    expect(long[0]).toContain("(truncated)");
    expect(long[0].length).toBeLessThan(5000);
    // More faults than the cap: first lines plus an omission tail naming
    // the remainder, so one bad multi-file edit cannot flood context.
    const many = Array.from({ length: 7 }, (_, i) => ({
      skipped: false,
      filePath: `m${i}.ts`,
      result: { stdout: `err${i}`, stderr: "", exitCode: 1, timedOut: false },
    }));
    const capped = lintBlockLines(many);
    expect(capped).toHaveLength(6);
    expect(capped[0]).toContain("err0");
    expect(capped[4]).toContain("err4");
    expect(capped[5]).toContain("2 more files: m5.ts, m6.ts");
  });

  it("accepts when the linter itself cannot run (infra stays accept)", async () => {
    writeConfig(
      directory,
      'profile: standard\ncommands:\n  lint:\n    ".ts": "eslint {file}"\non_edit:\n  format: false\n  lint: true\n',
    );
    writeFileSync(join(directory, "tool.ts"), "export const x = 1;\n");
    // Missing binary: the shell reports 127 with spawn text, no findings.
    const { ctx, captured } = stubContext({ exitCode: 127, stderr: "spawn eslint ENOENT" });
    apply(ctx);
    const postNext = async () => ({ kind: "accept" as const });
    const decision = await captured.post?.(
      { name: "write", arguments: { file_path: "tool.ts" } },
      { isError: false },
      postNext,
    );
    // Not a model fault: accept (the error is logged, the file is tracked,
    // and the gate re-checks) instead of blaming the edit.
    expect(decision?.kind).toBe("accept");
    expect(
      (decision as { additionalContexts?: Array<{ content: Array<{ text: string }> }> })
        .additionalContexts?.[0].content[0].text,
    ).toContain("lint failed for tool.ts");
  });

  it("turn-stopping drops the steer when the turn already aborted", async () => {
    writeConfig(directory, "profile: standard\n");
    writeFileSync(join(directory, "work.ts"), "export const y = 2;\n");
    const { ctx, captured } = stubContext();
    apply(ctx);
    const postNext = async () => ({ kind: "accept" as const });
    await captured.post?.(
      { name: "write", arguments: { file_path: "work.ts" } },
      { isError: false },
      postNext,
    );
    // Gate blocks (missing review) but the turn is dead: steering would wake
    // a *new* turn with stale feedback, so neither seam fires.
    const dead = { steer: vi.fn(), followup: vi.fn() };
    await captured.stopping?.({ agent: dead, turn: 1, signal: AbortSignal.abort() });
    expect(dead.steer).not.toHaveBeenCalled();
    expect(dead.followup).not.toHaveBeenCalled();
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

  it("registers df-status via dsh-commands", async () => {
    writeConfig(directory, "profile: standard\n");
    const { ctx, captured } = stubContext();
    apply(ctx);
    expect(captured.registered.map((r) => r.name)).toContain("df-status");
  });

  it("pre-step prepends the constitution on the first step of a session", async () => {
    writeFileSync(join(directory, "TEAM.md"), "# Team Rules\nDo the thing.");
    writeConfig(directory, 'profile: standard\nrules:\n  - "TEAM.md"\n');
    const { ctx, captured } = stubContext();
    apply(ctx);
    const passthrough = { kind: "enter", messages: [userMessage] };
    const next = async () => passthrough;
    const decision = (await captured.preStep?.(
      { agent: {}, messages: [userMessage], turn: 1 },
      next,
    )) as {
      kind: string;
      messages: Array<{ content: Array<{ text: string }> }>;
    };
    expect(decision?.kind).toBe("enter");
    expect(decision.messages[0].content[0].text).toContain("Team Rules");
    expect(decision.messages[decision.messages.length - 1]).toEqual(userMessage);
  });

  it("pre-step passes through once the session already received it", async () => {
    writeFileSync(join(directory, "TEAM.md"), "# Team Rules\nDo the thing.");
    writeConfig(directory, 'profile: standard\nrules:\n  - "TEAM.md"\n');
    const { ctx, captured } = stubContext();
    apply(ctx);
    const passthrough = { kind: "enter", messages: [userMessage] };
    const next = async () => passthrough;
    await captured.preStep?.({ agent: {}, messages: [userMessage], turn: 1 }, next);
    const second = await captured.preStep?.({ agent: {}, messages: [userMessage], turn: 1 }, next);
    expect(second).toBe(passthrough);
  });

  it("pre-step injects again for a new session", async () => {
    writeFileSync(join(directory, "TEAM.md"), "# Team Rules\nDo the thing.");
    writeConfig(directory, 'profile: standard\nrules:\n  - "TEAM.md"\n');
    const { ctx, captured } = stubContext();
    apply(ctx);
    const next = async () => ({ kind: "enter", messages: [userMessage] });
    const first = (await captured.preStep?.(
      { agent: {}, messages: [userMessage], turn: 1 },
      next,
    )) as {
      kind: string;
    };
    const second = (await captured.preStep?.(
      { agent: {}, messages: [userMessage], turn: 2 },
      next,
    )) as {
      kind: string;
    };
    expect(first?.kind).toBe("enter");
    expect(second?.kind).toBe("enter");
  });

  it("pre-step passes through untouched when the kill switch is set", async () => {
    writeConfig(directory, "profile: off\n");
    const { ctx, captured } = stubContext();
    apply(ctx);
    const passthrough = { kind: "enter", messages: [userMessage] };
    const next = async () => passthrough;
    const decision = await captured.preStep?.(
      { agent: {}, messages: [userMessage], turn: 1 },
      next,
    );
    expect(decision).toBe(passthrough);
  });

  it("df-goal creates a verified host goal", async () => {
    writeConfig(directory, "profile: standard\n");
    const { ctx, captured } = stubContext();
    apply(ctx);
    const goal = captured.registered.find((r) => r.name === "df-goal");
    expect(goal).toBeDefined();
    const decision = (await goal?.handler({ agent: {}, rawInput: "Ship the thing" })) as {
      kind: string;
      text: string;
    };
    expect(decision.kind).toBe("success");
    expect(captured.goalsCreated).toHaveLength(1);
    expect(captured.goalsCreated[0]?.objective).toContain("Ship the thing");
    expect(captured.goalsCreated[0]?.objective).toContain("dev_framework_verify");
  });

  it("df-goal rejects an empty objective without touching the host", async () => {
    writeConfig(directory, "profile: standard\n");
    const { ctx, captured } = stubContext();
    apply(ctx);
    const goal = captured.registered.find((r) => r.name === "df-goal");
    const decision = (await goal?.handler({ agent: {}, rawInput: "   " })) as {
      kind: string;
      text: string;
    };
    expect(decision.kind).toBe("error");
    expect(decision.text).toMatch(/objective/i);
    expect(captured.goalsCreated).toHaveLength(0);
  });

  it("df-goal fails closed when native /goal is missing", async () => {
    writeConfig(directory, "profile: standard\n");
    const { ctx, captured } = stubContext(undefined, []);
    apply(ctx);
    const goal = captured.registered.find((r) => r.name === "df-goal");
    const decision = (await goal?.handler({ agent: {}, rawInput: "Ship the thing" })) as {
      kind: string;
      text: string;
    };
    expect(decision.kind).toBe("error");
    expect(decision.text).toContain("native /goal");
    expect(captured.goalsCreated).toHaveLength(0);
  });

  it("df-verify reports the gate summary", async () => {
    writeConfig(directory, "profile: standard\n");
    const { ctx, captured } = stubContext();
    apply(ctx);
    const verify = captured.registered.find((r) => r.name === "df-verify");
    const decision = (await verify?.handler({ agent: {}, rawInput: "" })) as {
      kind: string;
      text: string;
    };
    expect(decision.kind).toBe("success");
    expect(decision.text).toContain("DEV_FRAMEWORK_VERDICT");
  });

  it("df-profile switches profile and rejects unknown names", async () => {
    writeConfig(directory, "profile: standard\n");
    const { ctx, captured } = stubContext();
    apply(ctx);
    const profile = captured.registered.find((r) => r.name === "df-profile");
    const ok = (await profile?.handler({ agent: {}, rawInput: "advisory" })) as {
      kind: string;
      text: string;
    };
    expect(ok.kind).toBe("success");
    expect(ok.text).toContain("advisory");
    const bad = (await profile?.handler({ agent: {}, rawInput: "bogus" })) as {
      kind: string;
      text: string;
    };
    expect(bad.kind).toBe("error");
    expect(bad.text).toContain("Unknown profile");
  });

  it("df-init scaffolds an empty project and hands the brief via followup", async () => {
    const { ctx, captured } = stubContext();
    apply(ctx);
    const init = captured.registered.find((r) => r.name === "df-init");
    const followup = vi.fn();
    const decision = (await init?.handler({ agent: { followup }, rawInput: "" })) as {
      kind: string;
      text: string;
    };
    expect(decision.kind).toBe("success");
    expect(followup).toHaveBeenCalledTimes(1);
    expect(existsSync(join(directory, ".opencode-dev-framework.yml"))).toBe(true);
  });

  it("pre-step keys injection by session identity, not just turn", async () => {
    writeFileSync(join(directory, "TEAM.md"), "# Team Rules\nDo the thing.");
    writeConfig(directory, 'profile: standard\nrules:\n  - "TEAM.md"\n');
    const { ctx, captured } = stubContext();
    apply(ctx);
    const next = async () => ({ kind: "enter", messages: [userMessage] });
    const sessionA = { session: { header: { id: "session-A" } } };
    const sessionB = { session: { header: { id: "session-B" } } };
    const first = (await captured.preStep?.(
      { agent: sessionA, messages: [userMessage], turn: 1 },
      next,
    )) as { kind: string; messages: unknown[] };
    // Same session id, later turn: pass through (already injected).
    const again = await captured.preStep?.(
      { agent: sessionA, messages: [userMessage], turn: 2 },
      next,
    );
    // Different session id: inject again.
    const other = (await captured.preStep?.(
      { agent: sessionB, messages: [userMessage], turn: 1 },
      next,
    )) as { kind: string; messages: unknown[] };
    expect(first?.kind).toBe("enter");
    expect(first.messages.length).toBeGreaterThan(1);
    expect((again as { messages: unknown[] }).messages).toHaveLength(1);
    expect(other?.kind).toBe("enter");
    expect(other.messages.length).toBeGreaterThan(1);
  });

  it("df-init reports an error when the agent has no followup seam", async () => {
    const { ctx, captured } = stubContext();
    apply(ctx);
    const init = captured.registered.find((r) => r.name === "df-init");
    const decision = (await init?.handler({ agent: {}, rawInput: "" })) as {
      kind: string;
      text: string;
    };
    // Scaffold may succeed, but the brief is lost without a handoff —
    // that must be an error, never a false success claim.
    expect(decision.kind).toBe("error");
    expect(decision.text).toMatch(/followup|handoff/i);
  });

  it("df-update reports current templates without a handoff", async () => {
    const { ctx, captured } = stubContext();
    apply(ctx);
    // First scaffold so there is something current to check.
    const init = captured.registered.find((r) => r.name === "df-init");
    const followup = vi.fn();
    await init?.handler({ agent: { followup }, rawInput: "" });
    followup.mockClear();
    const update = captured.registered.find((r) => r.name === "df-update");
    const decision = (await update?.handler({ agent: { followup }, rawInput: "" })) as {
      kind: string;
      text: string;
    };
    expect(decision.kind).toBe("success");
    expect(decision.text).toMatch(/current|nothing to do/i);
    expect(followup).not.toHaveBeenCalled();
  });

  it("df-runtime reports no snapshot before the first stamp, then live state", async () => {
    writeConfig(directory, "profile: standard\n");
    const { ctx, captured } = stubContext();
    apply(ctx);
    // The apply-time stamp is fire-and-forget: wait for it to land, then
    // remove it, so the null branch below is deterministic (no further
    // stamp fires on this path — stamps happen at apply + turn-stopping).
    const snapshotPath = join(
      directory,
      ".opencode",
      "opencode-dev-framework",
      "runtime-status.json",
    );
    const deadline = Date.now() + 5000;
    while (!existsSync(snapshotPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    rmSync(snapshotPath, { force: true });
    const runtime = captured.registered.find((r) => r.name === "df-runtime");
    const empty = (await runtime?.handler({ agent: {}, rawInput: "" })) as {
      kind: string;
      text: string;
    };
    expect(empty.kind).toBe("success");
    expect(empty.text).toContain("No runtime snapshot");
    const { writeRuntimeStatus } = await import("../src/core/runtime-status.js");
    await writeRuntimeStatus(directory, {
      idleHookVia: "turn-stopping",
      continuation: "armed",
      templates: undefined,
    });
    const live = (await runtime?.handler({ agent: {}, rawInput: "" })) as {
      kind: string;
      text: string;
    };
    expect(live.kind).toBe("success");
    expect(live.text).toContain("Turn-stopping hook");
  });

  it("agent tools verify, profile, status, and init over core", async () => {
    writeConfig(directory, "profile: standard\n");
    const { ctx, captured } = stubContext();
    apply(ctx);
    const names = captured.tools.map((t) => t.name);
    expect(names).toEqual([
      "dev_framework_verify",
      "dev_framework_set_profile",
      "dev_framework_status",
      "dev_framework_init",
    ]);
    const find = (name: string) => captured.tools.find((t) => t.name === name);
    const verify = (await find("dev_framework_verify")?.execute({}, {})) as string;
    expect(verify).toContain("DEV_FRAMEWORK_VERDICT");
    const switched = (await find("dev_framework_set_profile")?.execute(
      { profile: "advisory" },
      {},
    )) as string;
    expect(switched).toContain("advisory");
    const rejected = (await find("dev_framework_set_profile")?.execute(
      { profile: "bogus" },
      {},
    )) as string;
    expect(rejected).toContain("Invalid profile");
    const status = (await find("dev_framework_status")?.execute({}, {})) as string;
    expect(status).toMatch(/profile/i);
    const inited = (await find("dev_framework_init")?.execute({}, {})) as string;
    expect(inited.length).toBeGreaterThan(0);
    expect(existsSync(join(directory, ".opencode-dev-framework.yml"))).toBe(true);
  });

  it("df-update hands the refresh list via followup when drift is detected", async () => {
    const { ctx, captured } = stubContext();
    apply(ctx);
    const init = captured.registered.find((r) => r.name === "df-init");
    const followup = vi.fn();
    await init?.handler({ agent: { followup }, rawInput: "" });
    // Corrupt a deployed template file so drift is detected.
    const deployed = join(directory, ".opencode", "opencode-dev-framework", "review.md");
    if (existsSync(deployed)) {
      writeFileSync(deployed, "drifted content");
    } else {
      rmSync(join(directory, ".opencode"), { recursive: true, force: true });
    }
    followup.mockClear();
    const update = captured.registered.find((r) => r.name === "df-update");
    const decision = (await update?.handler({ agent: { followup }, rawInput: "" })) as {
      kind: string;
      text: string;
    };
    expect(decision.kind).toBe("success");
    expect(followup).toHaveBeenCalledTimes(1);
    expect(decision.text).toMatch(/drift|refresh/i);
  });
});
