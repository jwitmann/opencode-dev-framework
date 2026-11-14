import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache } from "../src/config";
import { isReviewArtifact } from "../src/harness";
import plugin from "../src/index";
import { resetRegistry, resolveIsChildSession } from "../src/registry";

const REVIEW = ".opencode/opencode-dev-framework/review.md";

describe("resolveIsChildSession", () => {
  beforeEach(() => {
    resetRegistry();
  });

  afterEach(() => {
    resetRegistry();
    vi.restoreAllMocks();
  });

  it("is true when the session has a parent", async () => {
    const getSession = vi.fn(async (_id: string) => ({ parentID: "ses_parent" }));
    await expect(resolveIsChildSession("ses_child", getSession)).resolves.toBe(true);
  });

  it("is false for a top-level session (null, missing, or empty parent)", async () => {
    const nullParent = vi.fn(async (_id: string) => ({ parentID: null }));
    await expect(resolveIsChildSession("ses_top", nullParent)).resolves.toBe(false);
    const missingParent = vi.fn(async (_id: string) => ({}));
    await expect(resolveIsChildSession("ses_top2", missingParent)).resolves.toBe(false);
    const emptyParent = vi.fn(async (_id: string) => ({ parentID: "" }));
    await expect(resolveIsChildSession("ses_top3", emptyParent)).resolves.toBe(false);
  });

  it("is false without a session getter (older core) and without a session", async () => {
    await expect(resolveIsChildSession("ses_x", undefined)).resolves.toBe(false);
    const getSession = vi.fn(async (_id: string) => ({ parentID: "ses_parent" }));
    await expect(resolveIsChildSession("", getSession)).resolves.toBe(false);
    expect(getSession).not.toHaveBeenCalled();
  });

  it("fails closed to top-level when the lookup throws", async () => {
    const getSession = vi.fn(async (_id: string) => {
      throw new Error("gone");
    });
    await expect(resolveIsChildSession("ses_x", getSession)).resolves.toBe(false);
  });

  it("caches the verdict per session", async () => {
    const getSession = vi.fn(async (_id: string) => ({ parentID: "ses_parent" }));
    await resolveIsChildSession("ses_cached", getSession);
    await resolveIsChildSession("ses_cached", getSession);
    expect(getSession).toHaveBeenCalledTimes(1);
  });
});

describe("isReviewArtifact", () => {
  it("matches the project-relative artifact path", () => {
    expect(isReviewArtifact(REVIEW)).toBe(true);
    expect(isReviewArtifact(`./${REVIEW}`)).toBe(true);
  });

  it("matches absolute paths under the project directory", () => {
    expect(isReviewArtifact(join("/proj", REVIEW), "/proj")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isReviewArtifact("src/index.ts")).toBe(false);
    expect(isReviewArtifact(".opencode/opencode-dev-framework/review.d/ses_abc.md")).toBe(false);
    expect(isReviewArtifact(join("/other", REVIEW), "/proj")).toBe(false);
    expect(isReviewArtifact("review.md")).toBe(false);
  });
});

describe("child sessions never touch the parent review artifact", () => {
  let directory: string;
  let logFile: string;
  let priorLogFile: string | undefined;

  beforeEach(() => {
    clearConfigCache();
    resetRegistry();
    directory = mkdtempSync(join(tmpdir(), "df-child-"));
    writeFileSync(join(directory, ".opencode-dev-framework.yml"), "profile: standard\n");
    logFile = join(mkdtempSync(join(tmpdir(), "df-child-log-")), "test.log");
    priorLogFile = process.env.OPENCODE_DEV_FRAMEWORK_LOG_FILE;
    process.env.OPENCODE_DEV_FRAMEWORK_LOG_FILE = logFile;
  });

  afterEach(() => {
    clearConfigCache();
    resetRegistry();
    rmSync(directory, { recursive: true, force: true });
    if (priorLogFile === undefined) {
      delete process.env.OPENCODE_DEV_FRAMEWORK_LOG_FILE;
    } else {
      process.env.OPENCODE_DEV_FRAMEWORK_LOG_FILE = priorLogFile;
    }
    vi.restoreAllMocks();
  });

  function createMockCtx(sessionGet: (id: string) => Promise<{ parentID?: string | null }>) {
    const sessionHooks = new Map<string, (event: never) => Promise<void> | void>();
    const toolHooks = new Map<string, (event: never) => Promise<void> | void>();
    const permissionHooks = new Map<string, (event: never) => Promise<void> | void>();
    const makeRegistration = () => ({ dispose: vi.fn(async () => {}) });
    const ctx = {
      location: { directory },
      session: {
        hook: vi.fn(async (name: string, callback: (event: never) => Promise<void> | void) => {
          sessionHooks.set(name, callback);
          return makeRegistration();
        }),
        prompt: vi.fn(),
        synthetic: vi.fn(),
        get: vi.fn(async (input: { sessionID: string }) => sessionGet(input.sessionID)),
      },
      permission: {
        hook: vi.fn(async (name: string, callback: (event: never) => Promise<void> | void) => {
          permissionHooks.set(name, callback);
          return makeRegistration();
        }),
      },
      tool: {
        hook: vi.fn(async (name: string, callback: (event: never) => Promise<void> | void) => {
          toolHooks.set(name, callback);
          return makeRegistration();
        }),
        transform: vi.fn(async (callback: (editor: { add: (t: unknown) => void }) => void) => {
          callback({ add: () => {} });
          return makeRegistration();
        }),
      },
      command: {
        transform: vi.fn(async (callback: (editor: { add: (t: unknown) => void }) => void) => {
          callback({ add: () => {} });
          return makeRegistration();
        }),
        list: vi.fn(async () => []),
      },
      event: {
        subscribe: () => ({
          [Symbol.asyncIterator]: async function* () {},
        }),
      },
      app: { version: "2.0.0" },
    };
    return { ctx, sessionHooks, toolHooks, permissionHooks };
  }

  async function setupWith(parents: Record<string, string | null>) {
    const { ctx, sessionHooks, toolHooks, permissionHooks } = createMockCtx(async (id) => ({
      parentID: parents[id] ?? null,
    }));
    const mod = plugin as unknown as { setup: (c: unknown) => Promise<unknown> };
    const result = await mod.setup(ctx);
    return {
      dispose: result as (() => Promise<void> | void) | undefined,
      sessionHooks,
      toolHooks,
      permissionHooks,
      sessionGet: ctx.session.get,
      synthetic: ctx.session.synthetic,
    };
  }

  function logText(): string {
    try {
      return readFileSync(logFile, "utf8");
    } catch {
      return "";
    }
  }

  it("skips the idle gate for a child session (no continuation, skip logged)", async () => {
    const h = await setupWith({ ses_child: "ses_parent" });
    try {
      const idle = h.sessionHooks.get("experimental.idle");
      expect(idle).toBeDefined();
      await idle?.({ sessionID: "ses_child" } as never);
      expect(h.synthetic).not.toHaveBeenCalled();
      expect(logText()).toContain("child session owes no review duty");
    } finally {
      if (typeof h.dispose === "function") await h.dispose();
    }
  });

  it("still gates a top-level session and never consults the parent twice", async () => {
    const h = await setupWith({ ses_top: null });
    try {
      const idle = h.sessionHooks.get("experimental.idle");
      await idle?.({ sessionID: "ses_top" } as never);
      await idle?.({ sessionID: "ses_top" } as never);
      expect(h.synthetic).not.toHaveBeenCalled();
      expect(logText()).not.toContain("child session owes no review duty");
      expect(h.sessionGet).toHaveBeenCalledTimes(1);
    } finally {
      if (typeof h.dispose === "function") await h.dispose();
    }
  });

  it("denies child writes to review.md, allows top-level and unrelated child edits", async () => {
    const h = await setupWith({ ses_child: "ses_parent", ses_top: null });
    try {
      const executeBefore = h.toolHooks.get("execute.before");
      expect(executeBefore).toBeDefined();
      const reviewInput = { filePath: REVIEW };
      await expect(
        executeBefore?.({ tool: "edit", sessionID: "ses_child", input: reviewInput } as never),
      ).rejects.toThrow(/child sessions never write/i);
      await expect(
        executeBefore?.({ tool: "edit", sessionID: "ses_top", input: reviewInput } as never),
      ).resolves.toBeUndefined();
      await expect(
        executeBefore?.({
          tool: "edit",
          sessionID: "ses_child",
          input: { filePath: "src/index.ts" },
        } as never),
      ).resolves.toBeUndefined();
      // Unrelated child edits never consult the parent lookup (zero hot-path impact).
      expect(h.sessionGet).toHaveBeenCalledTimes(2);
    } finally {
      if (typeof h.dispose === "function") await h.dispose();
    }
  });

  it("denies child review.md edits at the permission layer, leaves the rest untouched", async () => {
    const h = await setupWith({ ses_child: "ses_parent", ses_top: null });
    try {
      const permissionEvaluate = h.permissionHooks.get("evaluate");
      expect(permissionEvaluate).toBeDefined();
      const childEvent = {
        action: "edit",
        resources: [REVIEW],
        effect: "allow",
        sessionID: "ses_child",
      };
      await permissionEvaluate?.(childEvent as never);
      expect(childEvent.effect).toBe("deny");
      const topEvent = {
        action: "edit",
        resources: [REVIEW],
        effect: "allow",
        sessionID: "ses_top",
      };
      await permissionEvaluate?.(topEvent as never);
      expect(topEvent.effect).toBe("allow");
      const otherEvent = {
        action: "edit",
        resources: ["src/index.ts"],
        effect: "allow",
        sessionID: "ses_child",
      };
      await permissionEvaluate?.(otherEvent as never);
      expect(otherEvent.effect).toBe("allow");
    } finally {
      if (typeof h.dispose === "function") await h.dispose();
    }
  });
});
