import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { runCommand as defaultRunCommand, type RunCommand } from "./host.js";

/**
 * One-command DSH profile wiring (`df install-dsh`). Writes a managed block
 * into the profile's `cordis.patch.yml` — never rewrites user content:
 * everything outside the markers is preserved byte-for-byte, so user
 * comments and foreign entries survive every run.
 */

export const ODF_ENTRY_ID = "odf-gates";
/** Default entry name (npm-first): resolves once the package ships `./dsh`. */
export const ODF_NPM_SPEC = "opencode-dev-framework/dsh";
export const ODF_MANAGED_BEGIN =
  "# BEGIN odf-gates (managed by `df install-dsh` — do not hand-edit)";
export const ODF_MANAGED_END = "# END odf-gates";
/** Seams every profile provides. `agentPresets` joins only where detected. */
export const ODF_BASE_SEAMS = ["tools", "goals", "approval", "subagents"];

export interface InstallDshOptions {
  profile: string;
  dshHome?: string;
  /** Local adapter build (absolute path). Mutually exclusive with packageSpec. */
  distFile?: string;
  /** Package specifier. Defaults to {@link ODF_NPM_SPEC} (npm-first). */
  packageSpec?: string;
  /** Preset seam: auto-detect (default), force on, or force off. */
  withPresets?: "auto" | true | false;
  /** Replace a hand-maintained (unmarked) odf-gates entry. */
  force?: boolean;
  dryRun?: boolean;
  dshBin?: string;
  run?: RunCommand;
}

export interface InstallDshResult {
  profileDir: string;
  patchFile: string;
  createdPatchFile: boolean;
  changed: boolean;
  entryName: string;
  seams: string[];
  presetIncluded: boolean;
  packageSupportsDsh: boolean | undefined;
  warnings: string[];
}

export function resolveDshHome(explicit?: string): string {
  const fromEnv = process.env.DSH_HOME;
  return (
    explicit ?? (typeof fromEnv === "string" && fromEnv !== "" ? fromEnv : join(homedir(), ".dsh"))
  );
}

/** Probe one composed dump for preset-registry presence AND an
 * already-resolving `odf-gates` entry (bundle-provided base). A single
 * read-only subprocess call answers both; any failure degrades to
 * "absent / unsupported". */
export async function probeComposition(
  run: RunCommand,
  dshBin: string,
  profile: string,
): Promise<{ dump: string; presetsSupported: boolean; bundleEntry: boolean }> {
  const empty = { dump: "", presetsSupported: false, bundleEntry: false };
  try {
    const probe = await run([dshBin, "--profile", profile, "--dump-config"], {});
    const dump = `${probe.stdout}\n${probe.stderr}`;
    return {
      dump,
      presetsSupported: /agent-preset-registry|agent-presets/i.test(dump),
      bundleEntry: /(^|\n)\s*-\s*id:\s*odf-gates\b/.test(dump),
    };
  } catch {
    return empty;
  }
}

/** Probe the composed tree for the agent-preset registry. False on any failure. */
export async function detectPresetSupport(
  run: RunCommand,
  dshBin: string,
  profile: string,
): Promise<boolean> {
  return (await probeComposition(run, dshBin, profile)).presetsSupported;
}

/** Whether the profile's installed package already ships `./dsh`. Unknown on any failure. */
export async function checkPackageSupportsDsh(profileDir: string): Promise<boolean | undefined> {
  try {
    const manifestRaw = await readFile(join(profileDir, "package.json"), "utf8");
    const manifest = JSON.parse(manifestRaw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const version =
      manifest.dependencies?.["opencode-dev-framework"] ??
      manifest.devDependencies?.["opencode-dev-framework"];
    if (version === undefined) {
      return undefined;
    }
    const installedRaw = await readFile(
      join(profileDir, "node_modules", "opencode-dev-framework", "package.json"),
      "utf8",
    );
    const installed = JSON.parse(installedRaw) as { exports?: unknown };
    return (
      typeof installed.exports === "object" &&
      installed.exports !== null &&
      "./dsh" in installed.exports
    );
  } catch {
    return undefined;
  }
}

export function buildManagedBlock(entryName: string, seams: string[]): string {
  const lines = [
    ODF_MANAGED_BEGIN,
    "- insert:",
    `    - id: ${ODF_ENTRY_ID}`,
    `      name: ${entryName}`,
    `- id: ${ODF_ENTRY_ID}`,
    "  inject:",
    ...seams.map((seam) => `    - ${seam}`),
    ODF_MANAGED_END,
  ];
  return `${lines.join("\n")}\n`;
}

/** True when the text already carries our managed block (idempotent reruns). */
export function hasManagedBlock(patchText: string): boolean {
  return patchText.includes(ODF_MANAGED_BEGIN);
}

/** True when an odf-gates entry exists OUTSIDE the managed block. */
export function hasHandMaintainedEntry(patchText: string): boolean {
  const withoutManaged = patchText.replace(
    new RegExp(
      `${escapeRegExp(ODF_MANAGED_BEGIN)}[\\s\\S]*?${escapeRegExp(ODF_MANAGED_END)}\n?`,
      "g",
    ),
    "",
  );
  return new RegExp(`(^|\\n)\\s*(-\\s+id:\\s+${ODF_ENTRY_ID}\\b|id:\\s+${ODF_ENTRY_ID}\\b)`).test(
    withoutManaged,
  );
}

export function upsertManagedBlock(patchText: string | null, block: string): string {
  const previous = patchText ?? "";
  const stripped = previous.replace(
    new RegExp(
      `${escapeRegExp(ODF_MANAGED_BEGIN)}[\\s\\S]*?${escapeRegExp(ODF_MANAGED_END)}\n?`,
      "g",
    ),
    "",
  );
  const trimmed = stripped.replace(/\s+$/, "");
  return trimmed === "" ? block : `${trimmed}\n\n${block}`;
}

/**
 * Remove unmarked odf-gates entries (force mode): a header line naming the
 * id plus its more-indented continuation lines. Foreign entries and comments
 * are untouched — only lines that DECLARE the id match.
 */
export function removeUnmarkedEntries(patchText: string): string {
  const lines = patchText.split("\n");
  const kept: string[] = [];
  let skippingIndent: number | null = null;
  for (const line of lines) {
    if (skippingIndent !== null) {
      const indent = line.match(/^\s*/)?.[0].length ?? 0;
      if (line.trim() === "" || indent > skippingIndent) {
        continue;
      }
      skippingIndent = null;
    }
    const header = line.match(/^(\s*)(?:-\s+id|id):\s+odf-gates\b/);
    if (header !== null) {
      skippingIndent = header[1].length;
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function installDshProfile(options: InstallDshOptions): Promise<InstallDshResult> {
  const {
    profile,
    distFile,
    packageSpec = ODF_NPM_SPEC,
    withPresets = "auto",
    force = false,
    dryRun = false,
    dshBin = "dsh",
    run = defaultRunCommand,
  } = options;
  if (distFile !== undefined && options.packageSpec !== undefined) {
    throw new Error("df install-dsh: --dist and --package are mutually exclusive");
  }
  const profileDir = join(resolveDshHome(options.dshHome), "profiles", profile);
  if (!(await fileExists(profileDir))) {
    throw new Error(
      `df install-dsh: profile directory not found: ${profileDir} (create it with \`dsh plugin --profile ${profile} ...\` first)`,
    );
  }
  const entryName = distFile ?? packageSpec;
  const warnings: string[] = [];
  const explicitEntry = distFile !== undefined;

  const patchFile = join(profileDir, "cordis.patch.yml");
  const existing = (await fileExists(patchFile)) ? await readFile(patchFile, "utf8") : null;
  const handMaintained = !force && existing !== null && hasHandMaintainedEntry(existing);
  if (handMaintained) {
    throw new Error(
      "df install-dsh: a hand-maintained odf-gates entry already exists in cordis.patch.yml (refusing to touch it; rerun with --force to replace it with the managed block)",
    );
  }

  // One read-only probe answers preset support AND whether the bundle
  // layer already provides the entry (post-release world).
  const probe = await probeComposition(run, dshBin, profile);
  const bundleMode =
    !explicitEntry && existing !== null && !hasManagedBlock(existing) && probe.bundleEntry;

  if (bundleMode) {
    // The bundle base already resolves: only the profile-dependent
    // preset seam can still need a user-layer override.
    let presetIncluded: boolean;
    if (withPresets === false) {
      presetIncluded = false;
    } else {
      presetIncluded = probe.presetsSupported;
    }
    if (!presetIncluded) {
      return {
        profileDir,
        patchFile,
        createdPatchFile: false,
        changed: false,
        entryName,
        seams: [...ODF_BASE_SEAMS],
        presetIncluded,
        packageSupportsDsh: undefined,
        warnings: ["bundle base entry already resolves; no user-layer override needed."],
      };
    }
    const seams = [...ODF_BASE_SEAMS, "agentPresets"];
    const next = upsertManagedBlock(existing, buildManagedBlock(entryName, seams));
    const changed = next !== existing;
    if (!dryRun && changed) {
      await writeFile(patchFile, next, "utf8");
    }
    return {
      profileDir,
      patchFile,
      createdPatchFile: false,
      changed: changed && !dryRun,
      entryName,
      seams,
      presetIncluded,
      packageSupportsDsh: undefined,
      warnings: ["preset seam added as a user-layer override of the bundle base."],
    };
  }

  let presetIncluded: boolean;
  if (withPresets === true) {
    presetIncluded = true;
  } else if (withPresets === false) {
    presetIncluded = false;
  } else {
    presetIncluded = probe.presetsSupported;
    if (!presetIncluded) {
      warnings.push(
        "agent-preset registry not detected in this profile: spawning without the read-only preset (prompt-level restriction + guards).",
      );
    }
  }
  const seams = presetIncluded ? [...ODF_BASE_SEAMS, "agentPresets"] : [...ODF_BASE_SEAMS];

  const packageSupportsDsh =
    entryName === packageSpec ? await checkPackageSupportsDsh(profileDir) : undefined;
  if (packageSupportsDsh === false) {
    warnings.push(
      `installed opencode-dev-framework predates DSH support (no ./dsh export): run \`dsh plugin --profile ${profile} add opencode-dev-framework@latest\`, or reinstall with --dist.`,
    );
  } else if (packageSupportsDsh === undefined && entryName === packageSpec) {
    warnings.push(
      `could not confirm opencode-dev-framework is installed in this profile: run \`dsh plugin --profile ${profile} add opencode-dev-framework\` if the entry fails to resolve.`,
    );
  }

  const base = force && existing !== null ? removeUnmarkedEntries(existing) : (existing ?? "");
  const next = upsertManagedBlock(base === "" ? null : base, buildManagedBlock(entryName, seams));
  const changed = next !== (existing ?? "");
  if (!dryRun && changed) {
    if (existing === null) {
      await mkdir(profileDir, { recursive: true });
    }
    await writeFile(patchFile, next, "utf8");
  }
  return {
    profileDir,
    patchFile,
    createdPatchFile: existing === null && !dryRun,
    changed: changed && !dryRun,
    entryName,
    seams,
    presetIncluded,
    packageSupportsDsh,
    warnings,
  };
}
