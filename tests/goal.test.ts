import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache, resolveConfig } from "../src/config";
import {
  buildVerifiedObjective,
  checkGoalAvailability,
  extractObjectiveText,
  isNativeGoalListed,
  NATIVE_GOAL_LIMIT,
  runGoalCommand,
  VERIFICATION_ADDENDUM,
  type GoalDelegate,
} from "../src/goal";
import type { Config } from "../src/types";
import plugin from "../src/index";

function resolve(raw: Config) {
  return resolveConfig(raw, "/project/.opencode-dev-framework.yml");
}

/** Standard profile with a real typecheck command: meaningful + blocking. */
function meaningful() {
  return resolve({ profile: "standard", commands: { typecheck: "true" } });
}

function stubDelegate(failWith?: unknown) {
  const calls: { sessionID: string; name: string; text: string }[] = [];
  const delegate: GoalDelegate = async (args) => {
    calls.push(args);
    if (failWith !== undefined) throw failWith;
    return { ok: true };
  };
  return { calls, delegate };
}

describe("buildVerifiedObjective", () => {
  it("preserves the objective verbatim and appends the addendum once", () => {
    const built = buildVerifiedObjective("Implement the API contract change");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.text.startsWith("Implement the API contract change\n\n")).toBe(true);
    expect(built.text.endsWith(VERIFICATION_ADDENDUM)).toBe(true);
    expect(built.alreadyWrapped).toBe(false);
    // Exactly one addendum occurrence.
    expect(built.text.split(VERIFICATION_ADDENDUM)).toHaveLength(2);
  });

  it("does not double-wrap an objective that already contains the addendum", () => {
    const once = buildVerifiedObjective("Do the thing");
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    const twice = buildVerifiedObjective(once.text);
    expect(twice.ok).toBe(true);
    if (!twice.ok) return;
    expect(twice.text).toBe(once.text);
    expect(twice.alreadyWrapped).toBe(true);
  });

  it("rejects empty and whitespace-only objectives", () => {
    for (const objective of ["", "   ", "\n\t \n"]) {
      const built = buildVerifiedObjective(objective);
      expect(built.ok).toBe(false);
      if (built.ok) continue;
      expect(built.error).toContain("empty");
    }
  });

  it("accepts an exact-limit objective and rejects one character over with lengths", () => {
    const room = NATIVE_GOAL_LIMIT - "\n\n".length - VERIFICATION_ADDENDUM.length;
    const exact = buildVerifiedObjective("x".repeat(room));
    expect(exact.ok).toBe(true);

    const over = buildVerifiedObjective("x".repeat(room + 1));
    expect(over.ok).toBe(false);
    if (over.ok) return;
    // Useful length information, never silent truncation.
    expect(over.error).toContain(`${room + 1}`);
    expect(over.error).toContain(`${VERIFICATION_ADDENDUM.length}`);
    expect(over.error).toContain(`${NATIVE_GOAL_LIMIT}`);
    expect(over.error).toContain("never truncated");
  });

  it("rejects an already-wrapped objective over the limit with a combined length", () => {
    const room = NATIVE_GOAL_LIMIT - "\n\n".length - VERIFICATION_ADDENDUM.length;
    const wrapped = buildVerifiedObjective("x".repeat(room));
    expect(wrapped.ok).toBe(true);
    if (!wrapped.ok) return;
    // A retry that grew past the limit reports the single combined length,
    // not contradictory additive numbers.
    const grown = buildVerifiedObjective(`${wrapped.text} extra padding ${"y".repeat(50)}`);
    expect(grown.ok).toBe(false);
    if (grown.ok) return;
    expect(grown.error).toContain("previously appended verification addendum");
    expect(grown.error).toContain(`${wrapped.text.length + " extra padding ".length + 50}`);
    expect(grown.error).not.toContain("adds");
  });

  it("counts UTF-16 code units like native, not bytes or grapheme clusters", () => {
    // "😀" is one grapheme, two UTF-16 units, four UTF-8 bytes.
    const room = NATIVE_GOAL_LIMIT - "\n\n".length - VERIFICATION_ADDENDUM.length;
    const objective = `${"😀".repeat(Math.floor(room / 2))}${"y".repeat(room % 2)}`;
    expect(objective.length).toBe(room);
    expect(buildVerifiedObjective(objective)).toMatchObject({ ok: true });
    // One more astral character is two units over the ASCII-room budget.
    const over = buildVerifiedObjective(`${"😀".repeat(Math.floor(room / 2))}😀`);
    expect(over.ok).toBe(false);
  });
});

describe("checkGoalAvailability (§3.3)", () => {
  it("allows a blocking profile with meaningful checks and native goal present", () => {
    expect(checkGoalAvailability(meaningful(), true)).toEqual({ ok: true });
  });

  it("rejects a missing native capability with an actionable error", () => {
    const result = checkGoalAvailability(meaningful(), false);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("native /goal is not available");
  });

  it("rejects profile off as vacuous verification", () => {
    const result = checkGoalAvailability(resolve({ profile: "off" }), true);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('profile is "off"');
    expect(result.error).toContain("native /goal directly");
  });

  it("rejects advisory (non-blocking) naming the exact key and value found", () => {
    const advisory = resolve({ profile: "advisory", commands: { typecheck: "true" } });
    expect(advisory.gate.block_on_failure).toBe(false);
    const result = checkGoalAvailability(advisory, true);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("gate.block_on_failure is false");
    expect(result.error).toContain("blocking profile");
  });

  it("rejects a vacuous configuration with no meaningful check", () => {
    const vacuous = resolve({
      profile: "standard",
      gate: {
        run_typecheck: false,
        run_tests: false,
        lint_changed: false,
        require_review: false,
        block_on_failure: true,
      },
    });
    const result = checkGoalAvailability(vacuous, true);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("no meaningful completion check");
    expect(result.error).toContain("native /goal directly");
  });

  it("accepts review-only, acceptance-only, and lint-only configurations", () => {
    const reviewOnly = resolve({
      profile: "standard",
      gate: {
        run_typecheck: false,
        run_tests: false,
        lint_changed: false,
        require_review: true,
        block_on_failure: true,
      },
    });
    expect(checkGoalAvailability(reviewOnly, true)).toEqual({ ok: true });

    const acceptanceOnly = resolve({
      profile: "standard",
      gate: {
        run_typecheck: false,
        run_tests: false,
        lint_changed: false,
        require_review: false,
        block_on_failure: true,
        acceptance: [{ name: "contract", command: "./verify.sh" }],
      },
    });
    expect(checkGoalAvailability(acceptanceOnly, true)).toEqual({ ok: true });

    const lintOnly = resolve({
      profile: "standard",
      commands: { lint: { ".go": "golangci-lint run {dir}" } },
      gate: {
        run_typecheck: false,
        run_tests: false,
        lint_changed: true,
        require_review: false,
        block_on_failure: true,
      },
    });
    expect(checkGoalAvailability(lintOnly, true)).toEqual({ ok: true });
  });

  it("does not count a run flag with no command behind it as meaningful", () => {
    // run_typecheck defaults true but no typecheck command is configured.
    const flagWithoutCommand = resolve({
      profile: "standard",
      gate: {
        run_tests: false,
        lint_changed: false,
        require_review: false,
        block_on_failure: true,
      },
    });
    expect(checkGoalAvailability(flagWithoutCommand, true)).toEqual({
      ok: false,
      error: expect.stringContaining("no meaningful completion check"),
    });
  });
});

describe("extractObjectiveText / isNativeGoalListed", () => {
  it("extracts prompt text from the invocation struct and bare strings", () => {
    expect(extractObjectiveText({ text: "Do it", files: [] })).toBe("Do it");
    expect(extractObjectiveText("Bare objective")).toBe("Bare objective");
    expect(extractObjectiveText(undefined)).toBe("");
    expect(extractObjectiveText({})).toBe("");
    expect(extractObjectiveText(null)).toBe("");
  });

  it("detects native goal presence defensively", () => {
    expect(isNativeGoalListed([{ name: "goal" }, { name: "other" }])).toBe(true);
    // Real core shape: { location, data: [...] } (CommandListOutput).
    expect(isNativeGoalListed({ location: {}, data: [{ name: "goal" }] })).toBe(true);
    expect(isNativeGoalListed({ location: {}, data: [{ name: "other" }] })).toBe(false);
    expect(isNativeGoalListed([{ name: "other" }])).toBe(false);
    expect(isNativeGoalListed([])).toBe(false);
    expect(isNativeGoalListed({ location: {}, data: [] })).toBe(false);
    expect(isNativeGoalListed(undefined)).toBe(false);
    expect(isNativeGoalListed("goal")).toBe(false);
    expect(isNativeGoalListed({ location: {} })).toBe(false);
    expect(isNativeGoalListed([{ name: 42 }])).toBe(false);
  });
});

describe("runGoalCommand", () => {
  it("delegates exactly once with the flat native shape", async () => {
    const { calls, delegate } = stubDelegate();
    const result = await runGoalCommand({
      config: meaningful(),
      objective: "Implement the API contract change",
      sessionID: "ses_123",
      nativeGoalAvailable: true,
      delegate,
    });
    expect(result.delegated).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      sessionID: "ses_123",
      name: "goal",
      text: expect.stringContaining("Implement the API contract change"),
    });
    // The wrapper admits no kickoff of its own: the single delegate call is
    // the only session I/O this layer performs.
  });

  it("propagates native delegation errors without an unverified fallback", async () => {
    const failure = new Error("Command not found: goal");
    const { calls, delegate } = stubDelegate(failure);
    await expect(
      runGoalCommand({
        config: meaningful(),
        objective: "Do it",
        sessionID: "ses_123",
        nativeGoalAvailable: true,
        delegate,
      }),
    ).rejects.toBe(failure);
    // No retry, no substitute: exactly one attempt.
    expect(calls).toHaveLength(1);
  });

  it("returns set-up errors without touching the delegate", async () => {
    const { calls, delegate } = stubDelegate();
    const off = await runGoalCommand({
      config: resolve({ profile: "off" }),
      objective: "Do it",
      sessionID: "ses_123",
      nativeGoalAvailable: true,
      delegate,
    });
    expect(off.delegated).toBe(false);
    expect(calls).toHaveLength(0);

    const missing = await runGoalCommand({
      config: meaningful(),
      objective: "Do it",
      sessionID: "ses_123",
      nativeGoalAvailable: false,
      delegate,
    });
    expect(missing.delegated).toBe(false);
    if (missing.delegated) return;
    expect(missing.error).toContain("native /goal is not available");
    expect(calls).toHaveLength(0);
  });
});

describe("/df-goal command wiring (server registration)", () => {
  let directory: string;
  let cleanup: (() => Promise<void> | void) | undefined;

  function writeConfig(body: string): void {
    writeFileSync(join(directory, ".opencode-dev-framework.yml"), body);
  }

  function createMockCtx(options: { goalListed: boolean } = { goalListed: true }) {
    const addedCommands = new Map<string, { execute: (input: unknown) => Promise<void> }>();
    const sessionCommand = vi.fn(async () => ({ ok: true }));
    const ctx = {
      location: { directory },
      session: {
        hook: vi.fn(async () => ({ dispose: async () => {} })),
        prompt: vi.fn(),
        synthetic: vi.fn(),
        command: sessionCommand,
      },
      command: {
        transform: vi.fn(async (callback: (editor: { add: (c: unknown) => void }) => void) => {
          callback({
            add: (c: { name: string; execute: (input: unknown) => Promise<void> }) =>
              addedCommands.set(c.name, c),
          });
          return { dispose: async () => {} };
        }),
        list: vi.fn(async () =>
          options.goalListed
            ? { location: {}, data: [{ name: "goal" }, { name: "other" }] }
            : { location: {}, data: [{ name: "other" }] },
        ),
      },
      permission: {
        hook: vi.fn(async () => ({ dispose: async () => {} })),
      },
      tool: {
        hook: vi.fn(async () => ({ dispose: async () => {} })),
        transform: vi.fn(async () => ({ dispose: async () => {} })),
      },
      event: {
        subscribe: () => ({
          [Symbol.asyncIterator]: async function* () {},
        }),
      },
      app: { version: "2.2.2" },
    };
    return { ctx, addedCommands, sessionCommand };
  }

  beforeEach(() => {
    clearConfigCache();
    directory = mkdtempSync(join(tmpdir(), "df-goal-"));
  });

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
    clearConfigCache();
    rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function blockingConfig(): string {
    return 'profile: standard\ncommands:\n  typecheck: "true"\n';
  }

  it("registers df-goal through command.transform", async () => {
    writeConfig(blockingConfig());
    const { ctx, addedCommands } = createMockCtx();
    const mod = plugin as unknown as { setup: (c: unknown) => Promise<unknown> };
    cleanup = (await mod.setup(ctx)) as () => Promise<void> | void;
    expect(addedCommands.has("df-goal")).toBe(true);
  });

  it("delegates to native /goal once on invocation", async () => {
    writeConfig(blockingConfig());
    const { ctx, addedCommands, sessionCommand } = createMockCtx();
    const mod = plugin as unknown as { setup: (c: unknown) => Promise<unknown> };
    cleanup = (await mod.setup(ctx)) as () => Promise<void> | void;
    const command = addedCommands.get("df-goal");
    await command?.execute({
      sessionID: "ses_123",
      prompt: { text: "Implement the API contract change" },
      delivery: "steer",
    });
    expect(sessionCommand).toHaveBeenCalledTimes(1);
    expect(sessionCommand).toHaveBeenCalledWith({
      sessionID: "ses_123",
      name: "goal",
      text: expect.stringContaining("Implement the API contract change"),
    });
  });

  it("throws the availability error instead of delegating when off", async () => {
    writeConfig("profile: off\n");
    const { ctx, addedCommands, sessionCommand } = createMockCtx();
    const mod = plugin as unknown as { setup: (c: unknown) => Promise<unknown> };
    cleanup = (await mod.setup(ctx)) as () => Promise<void> | void;
    const command = addedCommands.get("df-goal");
    await expect(
      command?.execute({ sessionID: "ses_123", prompt: { text: "Do it" }, delivery: "steer" }),
    ).rejects.toThrow('profile is "off"');
    expect(sessionCommand).not.toHaveBeenCalled();
  });

  it("throws the capability error instead of delegating without native /goal", async () => {
    writeConfig(blockingConfig());
    const { ctx, addedCommands, sessionCommand } = createMockCtx({ goalListed: false });
    const mod = plugin as unknown as { setup: (c: unknown) => Promise<unknown> };
    cleanup = (await mod.setup(ctx)) as () => Promise<void> | void;
    const command = addedCommands.get("df-goal");
    await expect(
      command?.execute({ sessionID: "ses_123", prompt: { text: "Do it" }, delivery: "steer" }),
    ).rejects.toThrow("native /goal is not available");
    expect(sessionCommand).not.toHaveBeenCalled();
  });

  it("a stale handler cannot delegate after teardown", async () => {
    writeConfig(blockingConfig());
    const { ctx, addedCommands, sessionCommand } = createMockCtx();
    const mod = plugin as unknown as { setup: (c: unknown) => Promise<unknown> };
    cleanup = (await mod.setup(ctx)) as () => Promise<void> | void;
    const command = addedCommands.get("df-goal");
    await command?.execute({
      sessionID: "ses_123",
      prompt: { text: "Before teardown" },
      delivery: "steer",
    });
    expect(sessionCommand).toHaveBeenCalledTimes(1);
    await cleanup?.();
    cleanup = undefined;
    await command?.execute({
      sessionID: "ses_123",
      prompt: { text: "After teardown" },
      delivery: "steer",
    });
    // No second delegation: the stale closure no-ops like every other guard.
    expect(sessionCommand).toHaveBeenCalledTimes(1);
  });
});
