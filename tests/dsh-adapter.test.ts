import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractDshCommand, extractDshPaths } from "../src/adapters/dsh/extract";
import {
  apply,
  type DshContext,
  type DshPostDecision,
  type DshPreDecision,
  extractStructuredFindings,
  guardErrorDecision,
  isChildAgent,
  lintBlockLines,
  SPECIALIST_FINDINGS_SCHEMA,
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
      create: (_agent: unknown, request: { objective: string }) => {
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
    savedEnv = process.env.ODF_WORKDIR;
    process.env.ODF_WORKDIR = directory;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.ODF_WORKDIR;
    } else {
      process.env.ODF_WORKDIR = savedEnv;
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
    // No approval seam in this stub: warn allows with a warn log, exactly
    // like the OpenCode adapter. With the seam present (next test), the
    // human gets the question instead.
    const bash = await captured.pre(
      { name: "bash", arguments: { command: "rm -rf /tmp/x" } },
      next,
    );
    expect(bash).toEqual({ kind: "allow" });
    const env = await captured.pre({ name: "write", arguments: { file_path: ".env" } }, next);
    expect(env).toEqual({ kind: "allow" });
    expect(captured.warns.length).toBeGreaterThan(0);
  });

  it("asks the human on warn when the approval seam is present (TUI intent)", async () => {
    writeConfig(directory, 'profile: advisory\nprotect:\n  - ".env*"\n');
    const { ctx, captured } = stubContext();
    // The interactive TUI mounts user-approval with human answerers; the
    // guarded read succeeds, so the warn reaches the human as `ask`.
    // Either object- or function-shaped mounts count (services are
    // objects today; a callable mount must not silently degrade).
    for (const approval of [{}, () => {}]) {
      const withApproval = { ...ctx, approval };
      apply(withApproval as unknown as DshContext);
      const next = async (): Promise<DshPreDecision> => ({ kind: "allow" });
      const env = await captured.pre({ name: "write", arguments: { file_path: ".env" } }, next);
      expect(env.kind).toBe("ask");
      expect((env as { reason: string }).reason).toContain('matched ".env*"');
    }
  });

  it("never asks from child sessions: children report back, the parent decides", async () => {
    writeConfig(directory, 'profile: advisory\nprotect:\n  - ".env*"\n');
    const { ctx, captured } = stubContext();
    const withApproval = { ...ctx, approval: {} };
    apply(withApproval as unknown as DshContext);
    const next = async (): Promise<DshPreDecision> => ({ kind: "allow" });
    const childAgent = {
      session: { header: { origin: "subagent", parentSession: "ses_parent" } },
    };
    const env = await captured.pre(
      { name: "write", arguments: { file_path: ".env" }, agent: childAgent },
      next,
    );
    expect(env).toEqual({ kind: "allow" });
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
    // The artifact itself stays writable so the session can comply —
    // through either home (old deployments comply via the legacy path).
    const artifactDecision = await captured.pre(
      {
        name: "write",
        arguments: { file_path: ".dev-framework/preflight.md" },
      },
      next,
    );
    expect(artifactDecision).toEqual({ kind: "allow" });
    // Completing the artifact stand downs the duty — in either home, with
    // the new one winning when both exist (mid-migration writes converge).
    mkdirSync(join(directory, ".dev-framework"), { recursive: true });
    writeFileSync(
      join(directory, ".dev-framework", "preflight.md"),
      "# Preflight\n\n- [x] Do the thing\n",
    );
    const allowed = await captured.pre(
      { name: "write", arguments: { file_path: "work.ts" } },
      next,
    );
    expect(allowed).toEqual({ kind: "allow" });
  });

  it("reads a legacy-home pre-flight artifact (existing deployments)", async () => {
    writeConfig(directory, 'profile: standard\npreflight:\n  - "Do the thing"\n');
    const { ctx, captured } = stubContext();
    apply(ctx);
    const next = async (): Promise<DshPreDecision> => ({ kind: "allow" });
    const blocked = await captured.pre(
      { name: "write", arguments: { file_path: "work.ts" } },
      next,
    );
    expect(blocked.kind).toBe("deny");
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
      "dev_framework_ignore",
      "dev_framework_status",
      "dev_framework_init",
      "dev_framework_update",
      "dev_framework_runtime",
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
    // And status reads the degraded mount as degraded.
    const status = captured.registered.find((r) => r.name === "df-status");
    const out = (await status?.handler()) as { kind: string; text: string };
    expect(out.text).toContain("tools: unavailable (commands only)");
    expect(out.text).toContain("goals: unavailable (df-goal degrades to error text)");
    expect(out.text).toContain("approval: unavailable (warns allow + log)");
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

  it("turn-stopping inherits same-file review freshness", async () => {
    writeConfig(directory, "profile: standard\n");
    writeFileSync(join(directory, "work.ts"), "export const edited = true;\n");
    const { ctx, captured } = stubContext();
    apply(ctx);
    await captured.post?.(
      { name: "write", arguments: { filePath: join(directory, "work.ts") } },
      { isError: false },
      async () => ({ kind: "accept" }),
    );

    const artifact = join(directory, ".dev-framework", "review.md");
    mkdirSync(dirname(artifact), { recursive: true });
    const reviewBody =
      "Scope: work.ts was edited for the DSH review-freshness regression test. " +
      "Findings: pattern-guardian found no duplicated abstractions, style-enforcer found no " +
      "style violations, code-reviewer found no correctness defects, and the lead checked " +
      "the relevant evidence. Resolutions: no blocking findings remained after the review. " +
      "Verification: the focused test and shared completion suite were examined together.";
    writeFileSync(artifact, reviewBody);
    const old = new Date("2026-01-01T00:00:00Z");
    const recent = new Date("2026-01-02T00:00:00Z");
    utimesSync(artifact, old, old);
    utimesSync(join(directory, "work.ts"), recent, recent);

    const nextStep: unknown[] = [];
    const blocked = {
      steer: vi.fn((message: unknown) => nextStep.push(message)),
      followup: vi.fn(),
    };
    await captured.stopping?.({ agent: blocked, turn: 1 });
    expect(nextStep).toHaveLength(1);
    const blockedText = (nextStep[0] as { content: Array<{ text: string }> }).content
      .map((part) => part.text)
      .join("\n");
    expect(blockedText).toContain("stale");
    expect(blockedText).toContain("not written after");

    writeFileSync(artifact, `${reviewBody}\nFresh review written after the final edit.\n`);
    const fresh = { steer: vi.fn(), followup: vi.fn() };
    await captured.stopping?.({ agent: fresh, turn: 1 });
    expect(fresh.steer).not.toHaveBeenCalled();
    expect(fresh.followup).not.toHaveBeenCalled();
  });

  describe("continuity probe (plan 27)", () => {
    const continuityAgent = () => ({
      steer: vi.fn(),
      followup: vi.fn(),
      session: { header: { id: "ses-continuity-1" } },
    });

    const turnEvent = (seq: number, kind: string) => ({
      type: "turn/end",
      seq,
      time: 1700000000000 + seq,
      data: { turn: 1, reason: { kind } },
    });

    function withSessionQuery(
      ctx: DshContext,
      events: Array<Record<string, unknown>> | Error,
      onCall?: () => void,
    ): DshContext {
      const query = {
        readSession:
          events instanceof Error
            ? async () => {
                throw events;
              }
            : async () => {
                onCall?.();
                return { events: events.map((event) => ({ ...event })) };
              },
      };
      return {
        ...ctx,
        get: (name: string) => (name === "sessionQuery" ? query : undefined),
      } as unknown as DshContext;
    }

    async function statusText(captured: Captured, agent: unknown): Promise<string> {
      const status = captured.registered.find((r) => r.name === "df-status");
      const out = (await status?.handler({ agent, rawInput: "" })) as {
        kind: string;
        text: string;
      };
      return out.text;
    }

    it("reports resumed-interrupted for a log with an interrupted tail", async () => {
      writeConfig(directory, "profile: standard\n");
      const { ctx, captured } = stubContext();
      apply(
        withSessionQuery(ctx, [
          { type: "turn/start", seq: 1, time: 1700000000000, data: { turn: 1 } },
          turnEvent(2, "interrupted"),
        ]),
      );
      const agent = continuityAgent();
      await captured.stopping?.({ agent, turn: 1 });
      // No verdict delta: clean tree still passes with no steer.
      expect(agent.steer).not.toHaveBeenCalled();
      expect(await statusText(captured, agent)).toContain(
        "Continuity (this session): resumed after interruption",
      );
    });

    it("reports clean for a balanced log", async () => {
      writeConfig(directory, "profile: standard\n");
      const { ctx, captured } = stubContext();
      apply(
        withSessionQuery(ctx, [
          { type: "turn/start", seq: 1, time: 1700000000000, data: { turn: 1 } },
          turnEvent(2, "completed"),
        ]),
      );
      const agent = continuityAgent();
      await captured.stopping?.({ agent, turn: 1 });
      expect(await statusText(captured, agent)).toContain("Continuity (this session): clean");
    });

    it("reports unknown without querying for fallback turn identities", async () => {
      writeConfig(directory, "profile: standard\n");
      const { ctx, captured } = stubContext();
      const onCall = vi.fn();
      apply(withSessionQuery(ctx, [turnEvent(1, "interrupted")], onCall));
      const agent = { steer: vi.fn(), followup: vi.fn() };
      await captured.stopping?.({ agent, turn: 1 });
      expect(onCall).not.toHaveBeenCalled();
      expect(await statusText(captured, agent)).toContain("Continuity (this session): unknown");
    });

    it("reports unknown when the seam is absent and marks it unavailable", async () => {
      writeConfig(directory, "profile: standard\n");
      const { ctx, captured } = stubContext();
      apply(ctx);
      const agent = continuityAgent();
      await captured.stopping?.({ agent, turn: 1 });
      const text = await statusText(captured, agent);
      expect(text).toContain("Continuity (this session): unknown");
      expect(text).toContain("sessionQuery: unavailable");
    });

    it("reports unknown when the query throws and the gate still passes", async () => {
      writeConfig(directory, "profile: standard\n");
      const { ctx, captured } = stubContext();
      apply(withSessionQuery(ctx, new Error("corpus boom")));
      const agent = continuityAgent();
      await captured.stopping?.({ agent, turn: 1 });
      expect(agent.steer).not.toHaveBeenCalled();
      expect(await statusText(captured, agent)).toContain("Continuity (this session): unknown");
    });

    it("shares one query across concurrent stopping and status callers", async () => {
      writeConfig(directory, "profile: standard\n");
      const { ctx, captured } = stubContext();
      const onCall = vi.fn();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const query = {
        readSession: async () => {
          onCall();
          await gate;
          return { events: [] };
        },
      };
      apply({
        ...ctx,
        get: (name: string) => (name === "sessionQuery" ? query : undefined),
      } as unknown as DshContext);
      const agent = continuityAgent();
      const status = captured.registered.find((r) => r.name === "df-status");
      const racing = Promise.all([
        captured.stopping?.({ agent, turn: 1 }),
        status?.handler({ agent, rawInput: "" }),
      ]);
      await Promise.resolve();
      release();
      await racing;
      expect(onCall).toHaveBeenCalledTimes(1);
    });

    it("reports clean for an empty log and resolves via the direct property", async () => {
      writeConfig(directory, "profile: standard\n");
      const { ctx, captured } = stubContext();
      const query = { readSession: async () => ({ events: [] }) };
      apply({ ...ctx, sessionQuery: query } as unknown as DshContext);
      const agent = continuityAgent();
      await captured.stopping?.({ agent, turn: 1 });
      expect(agent.steer).not.toHaveBeenCalled();
      expect(await statusText(captured, agent)).toContain("Continuity (this session): clean");
    });

    it("reports unknown for an unreadable log shape and for a missing invocation", async () => {
      writeConfig(directory, "profile: standard\n");
      const { ctx, captured } = stubContext();
      const query = { readSession: async () => ({ events: "torn" }) };
      apply({
        ...ctx,
        get: () => {
          throw new Error("no facade get");
        },
        sessionQuery: query,
      } as unknown as DshContext);
      const agent = continuityAgent();
      await captured.stopping?.({ agent, turn: 1 });
      expect(await statusText(captured, agent)).toContain("Continuity (this session): unknown");
      const status = captured.registered.find((r) => r.name === "df-status");
      const out = (await status?.handler()) as { kind: string; text: string };
      expect(out.text).toContain("Continuity (this session): unknown");
    });

    it("marks sessionQuery available in the seams snapshot when mounted", async () => {
      writeConfig(directory, "profile: standard\n");
      const { ctx, captured } = stubContext();
      apply(withSessionQuery(ctx, []));
      const status = captured.registered.find((r) => r.name === "df-status");
      const out = (await status?.handler()) as { kind: string; text: string };
      expect(out.text).toContain("sessionQuery: available");
    });
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

  it("turn-stopping blocks termination on red and stays silent on pass", async () => {
    writeConfig(directory, "profile: standard\n");
    const { ctx, captured } = stubContext();
    apply(ctx);
    // No changed files: gate skips, verdict passes, and the host may stop.
    const quiet = { steer: vi.fn(), followup: vi.fn() };
    await captured.stopping?.({ agent: quiet, turn: 1 });
    expect(quiet.steer).not.toHaveBeenCalled();
    expect(quiet.followup).not.toHaveBeenCalled();
    // Track a file via post-execute (no review artifact on disk): the review
    // requirement blocks and steer enqueues the failure as same-turn work.
    writeFileSync(join(directory, "work.ts"), "export const y = 2;\n");
    const postNext = async () => ({ kind: "accept" as const });
    await captured.post?.(
      { name: "write", arguments: { file_path: "work.ts" } },
      { isError: false },
      postNext,
    );
    const nextStep: unknown[] = [];
    const blocked = {
      steer: vi.fn((message: unknown) => {
        nextStep.push(message);
      }),
      followup: vi.fn(),
    };
    await captured.stopping?.({ agent: blocked, turn: 1 });
    expect(blocked.steer).toHaveBeenCalledTimes(1);
    expect(blocked.followup).not.toHaveBeenCalled();
    // The host awaits turn-stopping listeners and breaks only when nextStep
    // is empty. This non-empty queue is the behavioral completion block.
    expect(nextStep).toHaveLength(1);
    // Resume-shaping: every host-committed message event needs a non-empty
    // data.id, so the blocking message carries one.
    const blockedMsg = nextStep[0] as { id?: unknown };
    expect(typeof blockedMsg.id).toBe("string");
    expect((blockedMsg.id as string).length).toBeGreaterThan(0);
  });

  it("stamps a unique id on every gate message (resume-shaping)", async () => {
    writeConfig(directory, "profile: standard\n");
    const { ctx, captured } = stubContext();
    apply(ctx);
    // Block the gate: tracked file, no review artifact.
    writeFileSync(join(directory, "work.ts"), "export const y = 2;\n");
    const postNext = async () => ({ kind: "accept" as const });
    await captured.post?.(
      { name: "write", arguments: { file_path: "work.ts" } },
      { isError: false },
      postNext,
    );
    const agent = { steer: vi.fn(), followup: vi.fn() };
    await captured.stopping?.({ agent, turn: 1 });
    const ids = agent.followup.mock.calls
      .concat(agent.steer.mock.calls)
      .map((call) => (call[0] as { id?: unknown }).id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(typeof id).toBe("string");
      expect((id as string).length).toBeGreaterThan(0);
    }
    expect(new Set(ids).size).toBe(ids.length);
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

  it("df-status names the adapter formatter and reports seam availability", async () => {
    writeConfig(directory, "profile: standard\n");
    const { ctx, captured } = stubContext();
    apply(ctx);
    const status = captured.registered.find((r) => r.name === "df-status");
    const out = (await status?.handler()) as { kind: string; text: string };
    expect(out.text).toContain("format-then-lint in post-execute");
    expect(out.text).not.toContain("OpenCode core's job");
    // Stub mounts tools + goals, not approval: degraded reads degraded.
    expect(out.text).toContain("tools: available (agent tools live)");
    expect(out.text).toContain("goals: available");
    expect(out.text).toContain("approval: unavailable (warns allow + log)");
  });

  it("df-status reports the approval seam when the host mounts it", async () => {
    writeConfig(directory, "profile: standard\n");
    const { ctx, captured } = stubContext();
    apply({ ...ctx, approval: {} } as unknown as DshContext);
    const status = captured.registered.find((r) => r.name === "df-status");
    const out = (await status?.handler()) as { kind: string; text: string };
    expect(out.text).toContain("approval: available (warns ask the human)");
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
    const followupImpl = vi.fn();
    // Receiver-enforcing: the handoff must keep the host method's
    // receiver (same class as the tools.register fix).
    const agent: { followup(this: unknown, m: unknown): void } = {
      followup(this: unknown) {
        if (this !== agent) {
          throw new TypeError("followup called without agent receiver");
        }
        followupImpl();
      },
    };
    const decision = (await init?.handler({ agent, rawInput: "" })) as {
      kind: string;
      text: string;
    };
    expect(decision.kind).toBe("success");
    expect(followupImpl).toHaveBeenCalledTimes(1);
    expect(existsSync(join(directory, ".dev-framework.yml"))).toBe(true);
    expect(existsSync(join(directory, ".opencode-dev-framework.yml"))).toBe(false);
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
    const snapshotPath = join(directory, ".dev-framework", "runtime-status.json");
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
    expect(live.text).toContain("standard/strict red gates block stopping");
  });

  it("agent tools verify, profile, status, and init over core", async () => {
    writeConfig(directory, "profile: standard\n");
    const { ctx, captured } = stubContext();
    apply(ctx);
    const names = captured.tools.map((t) => t.name);
    expect(names).toEqual([
      "dev_framework_verify",
      "dev_framework_set_profile",
      "dev_framework_ignore",
      "dev_framework_status",
      "dev_framework_init",
      "dev_framework_update",
      "dev_framework_runtime",
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
    // The legacy config already governs this deployment: init leaves it
    // alone instead of writing a new-named file that would shadow it.
    expect(existsSync(join(directory, ".dev-framework.yml"))).toBe(false);
    expect(existsSync(join(directory, ".opencode-dev-framework.yml"))).toBe(true);
    // The agent path kick-starts like the command: skills land where the
    // host `skill` tool scans, not only under `.opencode/skills`.
    expect(existsSync(join(directory, ".dsh/skills/peer-review/SKILL.md"))).toBe(true);
    const updated = (await find("dev_framework_update")?.execute({}, {})) as string;
    expect(updated).toContain("templates current");
    const runtime = (await find("dev_framework_runtime")?.execute({}, {})) as string;
    expect(runtime.length).toBeGreaterThan(0);
    const ignored = (await find("dev_framework_ignore")?.execute(
      { patterns: ["scratch/**"] },
      {},
    )) as string;
    expect(ignored).toContain("scratch/**");
    expect(ignored).toContain("Session-scoped only");
  });

  it("agent ignore tool returns readable validation errors for malformed input", async () => {
    writeConfig(directory, "profile: standard\n");
    const { ctx, captured } = stubContext();
    apply(ctx);
    const tool = captured.tools.find((t) => t.name === "dev_framework_ignore");
    expect(tool).toBeDefined();
    const malformed = [
      null,
      { patterns: "scratch/**" },
      { store: "yes" },
      { list: 1 },
      { remove: ["valid/**", 42] },
      { directory: 42 },
      { extra: true },
    ];
    for (const input of malformed) {
      const result = await tool?.execute(input, {});
      expect(result).toContain("Invalid dev_framework_ignore input");
    }
  });

  it("agent update tool returns the drift brief on a stale tree", async () => {
    writeConfig(directory, "profile: standard\n");
    const { ctx, captured } = stubContext();
    apply(ctx);
    const find = (name: string) =>
      captured.tools.find((t) => t.name === name) as unknown as {
        execute: (args: unknown, exec: unknown) => Promise<string>;
      };
    const updated = (await find("dev_framework_update")?.execute({}, {})) as string;
    // Fresh temp dir: every template missing, so the brief redirects.
    expect(updated).toContain("Run /df-init");
  });

  it("registers df-help with the command list", async () => {
    writeConfig(directory, "profile: standard\n");
    const { ctx, captured } = stubContext();
    apply(ctx);
    const help = captured.registered.find((r) => r.name === "df-help");
    expect(help?.description).toContain("commands");
    const out = (await help?.handler()) as { kind: string; text: string };
    expect(out.kind).toBe("success");
    expect(out.text).toContain("/df-status");
    expect(out.text).toContain("/df-update");
  });

  it("df-update hands the refresh list via followup when drift is detected", async () => {
    const { ctx, captured } = stubContext();
    apply(ctx);
    const init = captured.registered.find((r) => r.name === "df-init");
    const followupImpl = vi.fn();
    // Receiver-enforcing: the handoff must keep the host method's
    // receiver (same class as the tools.register fix).
    const agent: { followup(this: unknown, m: unknown): void } = {
      followup(this: unknown) {
        if (this !== agent) {
          throw new TypeError("followup called without agent receiver");
        }
        followupImpl();
      },
    };
    await init?.handler({ agent, rawInput: "" });
    // Corrupt a deployed template file so drift is detected.
    const deployed = join(directory, ".opencode", "opencode-dev-framework", "review.md");
    if (existsSync(deployed)) {
      writeFileSync(deployed, "drifted content");
    } else {
      rmSync(join(directory, ".opencode"), { recursive: true, force: true });
    }
    followupImpl.mockClear();
    const update = captured.registered.find((r) => r.name === "df-update");
    const decision = (await update?.handler({ agent, rawInput: "" })) as {
      kind: string;
      text: string;
    };
    expect(decision.kind).toBe("success");
    expect(followupImpl).toHaveBeenCalledTimes(1);
    expect(decision.text).toMatch(/drift|refresh/i);
  });
});

describe("specialist spawn (plan 26 slice 26.2)", () => {
  let directory: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "odf-spec-"));
    savedEnv = process.env.ODF_WORKDIR;
    process.env.ODF_WORKDIR = directory;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.ODF_WORKDIR;
    } else {
      process.env.ODF_WORKDIR = savedEnv;
    }
    clearConfigCache();
    rmSync(directory, { recursive: true, force: true });
  });

  function withSubagents(
    ctx: DshContext,
    opts: {
      capabilities?: {
        agentOptions?: boolean;
        agentPreset?: boolean;
        outputSchema?: boolean;
        depthLimit?: boolean;
      };
    } = {},
  ): Array<Record<string, unknown>> {
    const started: Array<Record<string, unknown>> = [];
    (ctx as unknown as Record<string, unknown>).subagents = {
      getProvider: (name: string) =>
        opts.capabilities === undefined ? { name } : { name, capabilities: opts.capabilities },
      resolveMaxDepth: () => undefined,
      startActivation: async (request: Record<string, unknown>) => {
        started.push(request);
        return { name: request.name };
      },
    };
    return started;
  }

  const capableOpts = {
    capabilities: {
      agentOptions: true,
      agentPreset: true,
      outputSchema: true,
      depthLimit: true,
    },
  };

  function withPresets(
    ctx: DshContext,
    mode: "ok" | "duplicate" | "fail" = "ok",
  ): { definitions: Array<Record<string, unknown>> } {
    const definitions: Array<Record<string, unknown>> = [];
    (ctx as unknown as Record<string, unknown>).agentPresets = {
      register: async (definition: Record<string, unknown>) => {
        if (mode === "duplicate") {
          throw new Error(`Duplicate agent preset: ${definition.id}`);
        }
        if (mode === "fail") {
          throw new Error("registry unavailable");
        }
        definitions.push(definition);
        return () => undefined;
      },
    };
    return { definitions };
  }

  async function flushPresetRegistration(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  function steerText(agent: { steer: { mock: { calls: unknown[][] } } }): string {
    const message = agent.steer.mock.calls[0]?.[0] as {
      content: Array<{ text: string }>;
    };
    return message.content.map((part) => part.text).join("\n");
  }

  async function blockOnce(
    captured: Captured,
    file = "work.ts",
  ): Promise<{ steer: ReturnType<typeof vi.fn>; followup: ReturnType<typeof vi.fn> }> {
    writeFileSync(join(directory, file), "export const x = 1;\n");
    const postNext = async () => ({ kind: "accept" as const });
    await captured.post?.(
      { name: "write", arguments: { file_path: file } },
      { isError: false },
      postNext,
    );
    // Stable session id (production shape): pre-step and turn-stopping
    // key the same session across turns; turn numbers alone would not.
    const agent = {
      steer: vi.fn(),
      followup: vi.fn(),
      session: { header: { id: "ses-spec" } },
    };
    await captured.stopping?.({ agent, turn: 1 });
    expect(agent.steer).toHaveBeenCalledTimes(1);
    return agent;
  }

  it("spawns all three reviewer kinds on a review block", async () => {
    writeConfig(directory, "profile: standard\n");
    const { ctx, captured } = stubContext();
    const started = withSubagents(ctx);
    apply(ctx);
    const agent = await blockOnce(captured);
    expect(started).toHaveLength(3);
    const byKind = new Map(
      (started as Array<Record<string, unknown>>).map((request) => [
        (request.label as string).replace("odf specialist review (", "").replace(")", ""),
        request,
      ]),
    );
    expect([...byKind.keys()].sort()).toEqual([
      "code-reviewer",
      "pattern-guardian",
      "style-enforcer",
    ]);
    for (const [kind, request] of byKind) {
      const typed = request as Record<string, unknown>;
      expect(typed.provider).toBe("spawn");
      expect(typed.delivery).toBe("parent");
      expect(typed.name).toMatch(new RegExp(`^odf-${kind}-\\d+$`));
      const prompt = (typed.prompt as Array<{ text: string }>).map((part) => part.text).join("\n");
      expect(prompt).toContain(kind);
      expect(prompt).toContain("work.ts");
    }
    const text = steerText(agent);
    for (const request of started) {
      expect(text).toContain(request.name as string);
    }
  });

  it("degrades to the inline steer when the seam is absent", async () => {
    writeConfig(directory, "profile: standard\n");
    const { ctx, captured } = stubContext();
    apply(ctx);
    const agent = await blockOnce(captured);
    expect(steerText(agent)).not.toContain("Specialist review dispatched");
  });

  it("never spawns in advisory, even with the seam present", async () => {
    writeConfig(directory, "profile: advisory\n");
    const { ctx, captured } = stubContext();
    const started = withSubagents(ctx);
    apply(ctx);
    writeFileSync(join(directory, "work.ts"), "export const x = 1;\n");
    const postNext = async () => ({ kind: "accept" as const });
    await captured.post?.(
      { name: "write", arguments: { file_path: "work.ts" } },
      { isError: false },
      postNext,
    );
    const agent = { steer: vi.fn(), followup: vi.fn() };
    await captured.stopping?.({ agent, turn: 1 });
    expect(started).toHaveLength(0);
  });

  it("folds specialist findings into the next steer, exactly once", async () => {
    writeConfig(directory, "profile: standard\n");
    const { ctx, captured } = stubContext();
    const started = withSubagents(ctx);
    apply(ctx);
    await blockOnce(captured);
    expect(started).toHaveLength(3);
    const pgName = (started as Array<Record<string, unknown>>).find((request) =>
      (request.name as string).startsWith("odf-pattern-guardian-"),
    )?.name as string;
    const notice = {
      role: "user",
      content: [
        {
          type: "text",
          text:
            `Background subagent ${pgName} finished and will do no further ` +
            "work unless you send it more. Its closing message: NO-DUP-HELPERS FOUND",
        },
      ],
      source: { kind: "subagent" },
    };
    await captured.preStep?.(
      {
        agent: { session: { header: { id: "ses-spec" } } },
        messages: [notice],
        turn: 2,
      },
      async () => ({ kind: "enter", messages: [] }),
    );
    // New work between blocks: the gate skips unchanged trees, so track
    // a fresh edit before each re-block.
    const track = async (file: string) => {
      writeFileSync(join(directory, file), "export const x = 1;\n");
      await captured.post?.(
        { name: "write", arguments: { file_path: file } },
        { isError: false },
        async () => ({ kind: "accept" as const }),
      );
    };
    await track("more.ts");
    const second = {
      steer: vi.fn(),
      followup: vi.fn(),
      session: { header: { id: "ses-spec" } },
    };
    await captured.stopping?.({ agent: second, turn: 2 });
    expect(second.steer).toHaveBeenCalledTimes(1);
    expect(steerText(second)).toContain("NO-DUP-HELPERS FOUND");
    // Only the collected kind re-spawns (style + correctness still pending).
    expect(started).toHaveLength(4);
    expect(started[3].name).toMatch(/^odf-pattern-guardian-\d+$/);
    // Findings are consumed: a further block carries no stale copy.
    await track("extra.ts");
    const third = {
      steer: vi.fn(),
      followup: vi.fn(),
      session: { header: { id: "ses-spec" } },
    };
    await captured.stopping?.({ agent: third, turn: 3 });
    expect(third.steer).toHaveBeenCalledTimes(1);
    expect(steerText(third)).not.toContain("NO-DUP-HELPERS FOUND");
    // Nothing new collected: no further spawns (all three kinds pending).
    expect(started).toHaveLength(4);
  });

  it("a silent child frees the pending slot without folding", async () => {
    writeConfig(directory, "profile: standard\n");
    const { ctx, captured } = stubContext();
    const started = withSubagents(ctx);
    apply(ctx);
    await blockOnce(captured);
    const childName = started[0].name as string;
    const silent = {
      role: "user",
      content: [
        {
          type: "text",
          text: `Background subagent ${childName} finished and will do no further work unless you send it more. Its closing message: `,
        },
      ],
      source: { kind: "subagent" },
    };
    await captured.preStep?.(
      {
        agent: { session: { header: { id: "ses-spec" } } },
        messages: [silent],
        turn: 2,
      },
      async () => ({ kind: "enter", messages: [] }),
    );
    // Slot freed: the next block dispatches a fresh specialist and folds nothing.
    writeFileSync(join(directory, "more.ts"), "export const x = 1;\n");
    await captured.post?.(
      { name: "write", arguments: { file_path: "more.ts" } },
      { isError: false },
      async () => ({ kind: "accept" as const }),
    );
    const second = {
      steer: vi.fn(),
      followup: vi.fn(),
      session: { header: { id: "ses-spec" } },
    };
    await captured.stopping?.({ agent: second, turn: 2 });
    // First block dispatched three kinds; only the silent one re-spawns.
    expect(started).toHaveLength(4);
    expect(steerText(second)).not.toContain("Specialist findings");
  });

  it("dispatches nothing on gate-blocks: reviewers never review a red tree", async () => {
    writeConfig(directory, 'profile: standard\ncommands:\n  test: "exit 1"\n');
    // The stub ignores argv, so force the failure at the transport.
    const { ctx, captured } = stubContext({ exitCode: 1 });
    const started = withSubagents(ctx);
    apply(ctx);
    const agent = await blockOnce(captured);
    expect(started).toHaveLength(0);
    expect(steerText(agent)).not.toContain("Specialist review dispatched");
  });

  it("registers the read-only reviewer preset and selects it on spawn", async () => {
    writeConfig(directory, "profile: standard\n");
    const { ctx, captured } = stubContext();
    const started = withSubagents(ctx);
    const { definitions } = withPresets(ctx);
    apply(ctx);
    await flushPresetRegistration();
    expect(definitions).toHaveLength(1);
    const definition = definitions[0] as Record<string, unknown>;
    expect(definition.id).toBe("odf-reviewer");
    const plugins = definition.plugins as Array<Record<string, unknown>>;
    const fs = plugins.find((plugin) => plugin.name === "@deepseek-ai/dsh-tool-fs");
    expect(fs?.config).toMatchObject({
      read: true,
      write: false,
      edit: false,
      applyPatch: false,
    });
    expect(plugins.some((plugin) => (plugin.name as string).includes("bash"))).toBe(false);
    await blockOnce(captured);
    expect(started).toHaveLength(3);
    for (const request of started) {
      expect(request.agentPreset).toBe("odf-reviewer");
    }
  });

  it("duplicate preset counts as ready: re-apply never throws", async () => {
    writeConfig(directory, "profile: standard\n");
    const { ctx, captured } = stubContext();
    const started = withSubagents(ctx);
    withPresets(ctx, "duplicate");
    apply(ctx);
    await flushPresetRegistration();
    await blockOnce(captured);
    expect(started).toHaveLength(3);
    for (const request of started) {
      expect(request.agentPreset).toBe("odf-reviewer");
    }
  });

  it("preset failure degrades to preset-less spawn, never to no spawn", async () => {
    writeConfig(directory, "profile: standard\n");
    const { ctx, captured } = stubContext();
    const started = withSubagents(ctx);
    withPresets(ctx, "fail");
    apply(ctx);
    await flushPresetRegistration();
    const agent = await blockOnce(captured);
    expect(started).toHaveLength(3);
    for (const request of started) {
      expect(request).not.toHaveProperty("agentPreset");
    }
    expect(steerText(agent)).toContain("Specialist review dispatched");
  });

  it("prefers the neutral brief over the OpenCode home", async () => {
    writeConfig(directory, "profile: standard\n");
    mkdirSync(join(directory, ".dev-framework", "agents"), { recursive: true });
    writeFileSync(
      join(directory, ".dev-framework", "agents", "pattern-guardian.md"),
      "NEUTRAL-BRIEF-MARKER\n",
    );
    mkdirSync(join(directory, ".opencode", "agents"), { recursive: true });
    writeFileSync(
      join(directory, ".opencode", "agents", "pattern-guardian.md"),
      "OPENCODE-BRIEF-MARKER\n",
    );
    const { ctx, captured } = stubContext();
    const started = withSubagents(ctx);
    apply(ctx);
    await blockOnce(captured);
    const prompt = (started[0].prompt as Array<{ text: string }>)
      .map((part) => part.text)
      .join("\n");
    expect(prompt).toContain("NEUTRAL-BRIEF-MARKER");
    expect(prompt).not.toContain("OPENCODE-BRIEF-MARKER");
  });

  it("falls back to the OpenCode home when no neutral brief exists", async () => {
    writeConfig(directory, "profile: standard\n");
    mkdirSync(join(directory, ".opencode", "agents"), { recursive: true });
    writeFileSync(
      join(directory, ".opencode", "agents", "pattern-guardian.md"),
      "OPENCODE-BRIEF-MARKER\n",
    );
    const { ctx, captured } = stubContext();
    const started = withSubagents(ctx);
    apply(ctx);
    await blockOnce(captured);
    const prompt = (started[0].prompt as Array<{ text: string }>)
      .map((part) => part.text)
      .join("\n");
    expect(prompt).toContain("OPENCODE-BRIEF-MARKER");
  });

  it("never spawns for child sessions", async () => {
    writeConfig(directory, "profile: standard\n");
    const { ctx, captured } = stubContext();
    const started = withSubagents(ctx);
    apply(ctx);
    writeFileSync(join(directory, "work.ts"), "export const x = 1;\n");
    const postNext = async () => ({ kind: "accept" as const });
    await captured.post?.(
      { name: "write", arguments: { file_path: "work.ts" } },
      { isError: false },
      postNext,
    );
    const child = {
      steer: vi.fn(),
      followup: vi.fn(),
      session: { header: { origin: "subagent", parentSession: "ses-parent" } },
    };
    await captured.stopping?.({ agent: child, turn: 1 });
    expect(started).toHaveLength(0);
    expect(child.steer).not.toHaveBeenCalled();
  });

  it("passes outputSchema when the provider supports it", async () => {
    writeConfig(directory, "profile: standard\n");
    const { ctx, captured } = stubContext();
    const started = withSubagents(ctx, capableOpts);
    apply(ctx);
    await blockOnce(captured);
    expect(started).toHaveLength(3);
    for (const request of started) {
      expect(request.outputSchema).toMatchObject({
        type: "object",
        required: ["summary", "findings"],
      });
      const prompt = (request.prompt as Array<{ text: string }>)
        .map((part) => part.text)
        .join("\n");
      expect(prompt).toContain("structured-output tool");
    }
  });

  it("omits outputSchema when the provider does not advertise it", async () => {
    writeConfig(directory, "profile: standard\n");
    const { ctx, captured } = stubContext();
    const started = withSubagents(ctx);
    apply(ctx);
    await blockOnce(captured);
    expect(started).toHaveLength(3);
    for (const request of started) {
      expect(request).not.toHaveProperty("outputSchema");
      const prompt = (request.prompt as Array<{ text: string }>)
        .map((part) => part.text)
        .join("\n");
      expect(prompt).not.toContain("structured-output tool");
    }
  });

  it("folds structured findings with the marker, preferring them over closing prose", async () => {
    writeConfig(directory, "profile: standard\n");
    const { ctx, captured } = stubContext();
    const started = withSubagents(ctx, capableOpts);
    apply(ctx);
    await blockOnce(captured);
    const pgName = (started as Array<Record<string, unknown>>).find((request) =>
      (request.name as string).startsWith("odf-pattern-guardian-"),
    )?.name as string;
    const structured = {
      summary: "STRUCTURED-SUMMARY",
      findings: [
        { file: "work.ts", line: 3, issue: "STRUCTURED-ISSUE", severity: "blocking" },
        { file: "other.ts", issue: "SECOND-ISSUE", severity: "note" },
      ],
    };
    const notice = {
      role: "user",
      content: [
        {
          type: "text",
          text:
            `Background subagent ${pgName} finished and will do no further ` +
            "work unless you send it more. Its closing message: CLOSING-PROSE",
        },
        { type: "text", text: `Structured result: ${JSON.stringify(structured)}` },
      ],
      source: { kind: "subagent" },
    };
    await captured.preStep?.(
      {
        agent: { session: { header: { id: "ses-spec" } } },
        messages: [notice],
        turn: 2,
      },
      async () => ({ kind: "enter", messages: [] }),
    );
    writeFileSync(join(directory, "more.ts"), "export const x = 1;\n");
    await captured.post?.(
      { name: "write", arguments: { file_path: "more.ts" } },
      { isError: false },
      async () => ({ kind: "accept" as const }),
    );
    const second = {
      steer: vi.fn(),
      followup: vi.fn(),
      session: { header: { id: "ses-spec" } },
    };
    await captured.stopping?.({ agent: second, turn: 2 });
    expect(second.steer).toHaveBeenCalledTimes(1);
    const text = steerText(second);
    expect(text).toContain("(structured)");
    expect(text).toContain("STRUCTURED-SUMMARY");
    expect(text).toContain("[work.ts:3] STRUCTURED-ISSUE (blocking)");
    expect(text).toContain("[other.ts] SECOND-ISSUE (note)");
  });

  it("malformed structured block falls back to the closing text", async () => {
    writeConfig(directory, "profile: standard\n");
    const { ctx, captured } = stubContext();
    const started = withSubagents(ctx, capableOpts);
    apply(ctx);
    await blockOnce(captured);
    const pgName = (started as Array<Record<string, unknown>>).find((request) =>
      (request.name as string).startsWith("odf-pattern-guardian-"),
    )?.name as string;
    const notice = {
      role: "user",
      content: [
        {
          type: "text",
          text:
            `Background subagent ${pgName} finished and will do no further ` +
            "work unless you send it more. Its closing message: FALLBACK-PROSE\n" +
            "Structured result: {not json",
        },
      ],
      source: { kind: "subagent" },
    };
    await captured.preStep?.(
      {
        agent: { session: { header: { id: "ses-spec" } } },
        messages: [notice],
        turn: 2,
      },
      async () => ({ kind: "enter", messages: [] }),
    );
    writeFileSync(join(directory, "more.ts"), "export const x = 1;\n");
    await captured.post?.(
      { name: "write", arguments: { file_path: "more.ts" } },
      { isError: false },
      async () => ({ kind: "accept" as const }),
    );
    const second = {
      steer: vi.fn(),
      followup: vi.fn(),
      session: { header: { id: "ses-spec" } },
    };
    await captured.stopping?.({ agent: second, turn: 2 });
    expect(second.steer).toHaveBeenCalledTimes(1);
    expect(steerText(second)).toContain("FALLBACK-PROSE");
    expect(steerText(second)).not.toContain("(structured)");
  });
});

describe("extractStructuredFindings (plan 27)", () => {
  const valid = {
    summary: "SUM",
    findings: [{ file: "a.ts", line: 1, issue: "ISS", severity: "blocking" }],
  };

  it("returns null without the prefix", () => {
    expect(extractStructuredFindings("Background subagent x finished.")).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(extractStructuredFindings("Structured result: {oops")).toBeNull();
  });

  it("returns null on the wrong shape", () => {
    expect(extractStructuredFindings("Structured result: [1,2]")).toBeNull();
    expect(extractStructuredFindings('Structured result: {"summary":"s"}')).toBeNull();
    expect(
      extractStructuredFindings('Structured result: {"summary":"s","findings":[]}'),
    ).toBeNull();
  });

  it("renders summary plus one line per finding", () => {
    expect(extractStructuredFindings(`Structured result: ${JSON.stringify(valid)}`)).toEqual([
      "SUM",
      "- [a.ts:1] ISS (blocking)",
    ]);
  });

  it("skips unusable entries, coerces unknown severities to note", () => {
    const mixed = {
      summary: "SUM",
      findings: [
        { file: "", issue: "empty file", severity: "blocking" },
        { file: "b.ts", issue: "", severity: "blocking" },
        { file: "c.ts", issue: "KEPT-AS-NOTE", severity: "critical" },
        { file: "d.ts", issue: "KEPT", severity: "should-fix" },
        { file: "e.ts", issue: "KEPT-NOLINE", severity: "note", line: 1.5 },
        { file: "f.ts", issue: "KEPT-NOSUFFIX", severity: "blocking", line: 0 },
        { file: "g.ts", issue: "KEPT-NOSUFFIX", severity: "blocking", line: -3 },
      ],
    };
    expect(extractStructuredFindings(`Structured result: ${JSON.stringify(mixed)}`)).toEqual([
      "SUM",
      "- [c.ts] KEPT-AS-NOTE (note)",
      "- [d.ts] KEPT (should-fix)",
      "- [e.ts] KEPT-NOLINE (note)",
      "- [f.ts] KEPT-NOSUFFIX (blocking)",
      "- [g.ts] KEPT-NOSUFFIX (blocking)",
    ]);
    const allBad = { summary: "SUM", findings: [{ file: "", issue: "", severity: "x" }] };
    expect(extractStructuredFindings(`Structured result: ${JSON.stringify(allBad)}`)).toBeNull();
  });

  it("defaults an empty summary instead of rendering a blank line", () => {
    const empty = {
      summary: "   ",
      findings: [{ file: "a.ts", issue: "ISS", severity: "blocking" }],
    };
    expect(extractStructuredFindings(`Structured result: ${JSON.stringify(empty)}`)).toEqual([
      "(no summary)",
      "- [a.ts] ISS (blocking)",
    ]);
  });

  it("caps folded findings and truncates long summaries", () => {
    const many = {
      summary: "S",
      findings: Array.from({ length: 25 }, (_, i) => ({
        file: `f${i}.ts`,
        issue: `ISSUE-${i}`,
        severity: "note",
      })),
    };
    const folded = extractStructuredFindings(`Structured result: ${JSON.stringify(many)}`);
    expect(folded?.length).toBe(22);
    expect(folded?.[1]).toBe("- [f0.ts] ISSUE-0 (note)");
    expect(folded?.[20]).toBe("- [f19.ts] ISSUE-19 (note)");
    expect(folded?.[21]).toBe("(findings omitted for 5 more entries)");
    const long = {
      summary: `x${"y".repeat(3000)}`,
      findings: [{ file: "a.ts", issue: "ISS", severity: "blocking" }],
    };
    const truncated = extractStructuredFindings(`Structured result: ${JSON.stringify(long)}`);
    expect(truncated?.[0].length).toBe(2000);
  });

  it("keeps the schema inside the host subset (object root, closed, minimal keywords)", () => {
    const allowed = new Set([
      "type",
      "properties",
      "required",
      "additionalProperties",
      "items",
      "enum",
    ]);
    const violations: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (typeof node !== "object" || node === null) {
        violations.push(`${path} must be an object`);
        return;
      }
      for (const key of Object.keys(node)) {
        if (!allowed.has(key)) {
          violations.push(`${path}.${key} not in host subset`);
        }
      }
      const record = node as Record<string, unknown>;
      if (typeof record.properties === "object" && record.properties !== null) {
        for (const [name, child] of Object.entries(record.properties)) {
          walk(child, `${path}.${name}`);
        }
      }
      if (typeof record.items === "object" && record.items !== null) {
        walk(record.items, `${path}[]`);
      }
    };
    walk(SPECIALIST_FINDINGS_SCHEMA, "schema");
    expect(violations).toEqual([]);
    expect(SPECIALIST_FINDINGS_SCHEMA.type).toBe("object");
    expect(SPECIALIST_FINDINGS_SCHEMA.additionalProperties).toBe(false);
  });
});

describe("child tool guard (hardening: investigation-only by construction)", () => {
  const directory = mkdtempSync(join(tmpdir(), "odf-child-guard-"));
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.ODF_WORKDIR;
    process.env.ODF_WORKDIR = directory;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.ODF_WORKDIR;
    } else {
      process.env.ODF_WORKDIR = savedEnv;
    }
  });

  function childExec() {
    return {
      agent: {
        session: {
          header: { id: "ses-child", origin: "subagent", parentSession: "ses-parent" },
        },
      },
    };
  }

  it("denies every gate tool to child sessions with the redirect", async () => {
    writeConfig(directory, "profile: standard\n");
    const { ctx, captured } = stubContext();
    apply(ctx);
    expect(captured.tools).toHaveLength(7);
    for (const tool of captured.tools) {
      const out = (await tool.execute({}, childExec())) as string;
      expect(out).toContain("Child sessions may not invoke");
      expect(out).toContain(tool.name);
    }
  });

  it("leaves top-level tool calls untouched", async () => {
    writeConfig(directory, "profile: standard\n");
    const { ctx, captured } = stubContext();
    apply(ctx);
    const status = captured.tools.find((t) => t.name === "dev_framework_status");
    const out = (await status?.execute({}, { agent: {} })) as string;
    expect(out).toContain("Profile:");
    expect(out).not.toContain("Child sessions may not invoke");
  });
});
