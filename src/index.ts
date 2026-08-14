import type { Plugin } from "@opencode-ai/plugin";

/**
 * opencode-dev-framework plugin entry point.
 *
 * Phase 1 scaffold stub — hooks are wired in later phases:
 * - session.created   -> constitution injection (Phase 6)
 * - tool.execute.before -> guardrails (Phase 3)
 * - file.edited       -> per-edit lint (Phase 4)
 * - session.idle      -> completion gate (Phase 5)
 */
export const devFramework: Plugin = async (_ctx) => {
  return {};
};

export default devFramework;
