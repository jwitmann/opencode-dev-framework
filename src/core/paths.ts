/**
 * Framework-private project paths, harness-neutral by design.
 *
 * Harness-discovered directories (`.opencode/agents`, `.opencode/skills`,
 * the DSH `.dsh/skills` mirror) live where each host looks and are NOT
 * here. Everything below is read and written only by the framework
 * itself, so it shares one neutral home (`.dev-framework/`) on every
 * harness. The previous home (`.opencode/opencode-dev-framework/`) is
 * kept as a read fallback so existing deployments converge without a
 * migration: readers try the new location first, writers use it only.
 */

/** Neutral framework-private home (new deployments). */
export const FRAMEWORK_DIR = ".dev-framework";

/** Previous framework-private home (existing deployments; read fallback). */
export const LEGACY_FRAMEWORK_DIR = ".opencode/opencode-dev-framework";

export const REVIEW_FILE = "review.md";
export const PREFLIGHT_FILE = "preflight.md";
export const RULES_DIR = "rules";
export const RUNTIME_STATUS_FILE = "runtime-status.json";

/** Review artifact (new neutral home). */
export const REVIEW_ARTIFACT_REL = `${FRAMEWORK_DIR}/${REVIEW_FILE}`;

/** Previous review artifact home (existing deployments; still enforced). */
export const LEGACY_REVIEW_ARTIFACT_REL = `${LEGACY_FRAMEWORK_DIR}/${REVIEW_FILE}`;

/** Pre-flight artifact (new neutral home). */
export const PREFLIGHT_ARTIFACT_REL = `${FRAMEWORK_DIR}/${PREFLIGHT_FILE}`;

/** Previous pre-flight artifact home (existing deployments; still read). */
export const LEGACY_PREFLIGHT_ARTIFACT_REL = `${LEGACY_FRAMEWORK_DIR}/${PREFLIGHT_FILE}`;

/** Review artifact, new location first. */
export const REVIEW_RELS = [REVIEW_ARTIFACT_REL, LEGACY_REVIEW_ARTIFACT_REL] as const;

/** Pre-flight artifact, new location first. */
export const PREFLIGHT_RELS = [PREFLIGHT_ARTIFACT_REL, LEGACY_PREFLIGHT_ARTIFACT_REL] as const;

/** Local rules directory, new location first. */
export const RULES_DIR_RELS = [
  `${FRAMEWORK_DIR}/${RULES_DIR}`,
  `${LEGACY_FRAMEWORK_DIR}/${RULES_DIR}`,
] as const;

/** Runtime snapshot, new location first. */
export const RUNTIME_STATUS_RELS = [
  `${FRAMEWORK_DIR}/${RUNTIME_STATUS_FILE}`,
  `${LEGACY_FRAMEWORK_DIR}/${RUNTIME_STATUS_FILE}`,
] as const;
