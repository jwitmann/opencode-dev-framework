import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildManagedBlock,
  hasHandMaintainedEntry,
  installDshProfile,
  ODF_MANAGED_BEGIN,
  ODF_MANAGED_END,
  upsertManagedBlock,
} from "../src/core/install-dsh.js";

const HEADER = [
  "# Your patch layer for this dsh profile, applied after every bundle layer:",
  "# a top-level YAML array of loader patch entries (id-targeted config",
  "# overrides, disables, and insert lists; `!!js` expressions allowed).",
  "",
].join("\n");

function makeProfile(patchBody: string | null, manifest?: unknown): string {
  const home = mkdtempSync(join(tmpdir(), "odf-install-dsh-"));
  const dir = join(home, "profiles", "probe");
  mkdirSync(dir, { recursive: true });
  if (patchBody !== null) {
    writeFileSync(join(dir, "cordis.patch.yml"), patchBody, "utf8");
  }
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      manifest ?? {
        name: "dsh-profile-probe",
        dependencies: { "opencode-dev-framework": "^1.0.0" },
      },
    ),
    "utf8",
  );
  return home;
}

function dumpWithRegistry(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: "- id: dsh-tui-agent-preset-registry\n  name: '@deepseek-ai/dsh-agent-preset-registry'",
    stderr: "",
    exitCode: 0,
  };
}

function dumpWithoutRegistry(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: "- id: tool-subagent\n  name: '@deepseek-ai/dsh-tool-subagent'",
    stderr: "",
    exitCode: 0,
  };
}

describe("install-dsh", () => {
  it("appends a managed block, preserving user comments and entries", async () => {
    const foreign = '- id: llm-pi-ai\n  name: "@deepseek-ai/dsh-llm-pi-ai"\n';
    const home = makeProfile(`${HEADER}${foreign}`);
    const run = vi.fn(async () => dumpWithoutRegistry());
    const result = await installDshProfile({ profile: "probe", dshHome: home, run });
    expect(result.changed).toBe(true);
    expect(result.presetIncluded).toBe(false);
    expect(result.seams).toEqual(["tools", "goals", "approval", "subagents"]);
    const written = readFileSync(join(home, "profiles", "probe", "cordis.patch.yml"), "utf8");
    expect(written).toContain("# Your patch layer for this dsh profile");
    expect(written).toContain(foreign.trim());
    expect(written).toContain(ODF_MANAGED_BEGIN);
    expect(written).toContain(ODF_MANAGED_END);
    expect(written).toContain("name: opencode-dev-framework/dsh");
  });

  it("is idempotent: a second run changes nothing", async () => {
    const home = makeProfile(`${HEADER}`);
    const run = vi.fn(async () => dumpWithoutRegistry());
    const first = await installDshProfile({ profile: "probe", dshHome: home, run });
    expect(first.changed).toBe(true);
    const second = await installDshProfile({ profile: "probe", dshHome: home, run });
    expect(second.changed).toBe(false);
    const written = readFileSync(join(home, "profiles", "probe", "cordis.patch.yml"), "utf8");
    expect(written.split(ODF_MANAGED_BEGIN)).toHaveLength(2);
  });

  it("includes agentPresets when the registry is detected", async () => {
    const home = makeProfile(HEADER);
    const run = vi.fn(async () => dumpWithRegistry());
    const result = await installDshProfile({ profile: "probe", dshHome: home, run });
    expect(result.presetIncluded).toBe(true);
    expect(result.seams).toContain("agentPresets");
  });

  it("honors --dist and --no-presets", async () => {
    const home = makeProfile(HEADER);
    const run = vi.fn(async () => dumpWithRegistry());
    const result = await installDshProfile({
      profile: "probe",
      dshHome: home,
      run,
      distFile: "/opt/odf/dist/adapters/dsh/index.js",
      withPresets: false,
    });
    expect(result.entryName).toBe("/opt/odf/dist/adapters/dsh/index.js");
    expect(result.seams).not.toContain("agentPresets");
    expect(run).toHaveBeenCalledTimes(1); // single composition probe (bundle + preset answers)
  });

  it("writes only the preset override when the bundle base already resolves", async () => {
    const home = makeProfile(HEADER);
    const dump =
      "entries:\n- id: odf-gates\n  name: opencode-dev-framework/dsh\n- id: tool-fs\nagent-preset-registry active\n";
    const run = vi.fn(async () => ({ stdout: dump, stderr: "", exitCode: 0 }));
    const result = await installDshProfile({ profile: "probe", dshHome: home, run });
    expect(result.changed).toBe(true);
    expect(result.presetIncluded).toBe(true);
    expect(result.seams).toContain("agentPresets");
    const written = readFileSync(join(home, "profiles", "probe", "cordis.patch.yml"), "utf8");
    expect(written).toContain(ODF_MANAGED_BEGIN);
    expect(written).toContain("# Your patch layer for this dsh profile");
  });

  it("leaves a resolving bundle base alone when presets are unsupported", async () => {
    const home = makeProfile(HEADER);
    const dump = "entries:\n- id: odf-gates\n  name: opencode-dev-framework/dsh\n";
    const run = vi.fn(async () => ({ stdout: dump, stderr: "", exitCode: 0 }));
    const result = await installDshProfile({ profile: "probe", dshHome: home, run });
    expect(result.changed).toBe(false);
    expect(result.presetIncluded).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/bundle base/);
    const written = readFileSync(join(home, "profiles", "probe", "cordis.patch.yml"), "utf8");
    expect(written).not.toContain(ODF_MANAGED_BEGIN);
  });

  it("refuses a hand-maintained entry without --force, replaces with it", async () => {
    const hand = `${HEADER}- insert:\n    - id: odf-gates\n      name: /tmp/old.js\n`;
    const home = makeProfile(hand);
    const run = vi.fn(async () => dumpWithoutRegistry());
    await expect(installDshProfile({ profile: "probe", dshHome: home, run })).rejects.toThrow(
      /hand-maintained/,
    );
    const forced = await installDshProfile({ profile: "probe", dshHome: home, run, force: true });
    expect(forced.changed).toBe(true);
    const written = readFileSync(join(home, "profiles", "probe", "cordis.patch.yml"), "utf8");
    expect(written).not.toContain("/tmp/old.js");
    expect(written).toContain("name: opencode-dev-framework/dsh");
    expect(written).toContain("# Your patch layer for this dsh profile");
  });

  it("dry-run writes nothing", async () => {
    const home = makeProfile(HEADER);
    const run = vi.fn(async () => dumpWithoutRegistry());
    const result = await installDshProfile({ profile: "probe", dshHome: home, run, dryRun: true });
    expect(result.changed).toBe(false);
    const written = readFileSync(join(home, "profiles", "probe", "cordis.patch.yml"), "utf8");
    expect(written).not.toContain(ODF_MANAGED_BEGIN);
  });

  it("warns when the probe fails instead of blocking", async () => {
    const home = makeProfile(HEADER);
    const run = vi.fn(async () => {
      throw new Error("no dsh on PATH");
    });
    const result = await installDshProfile({ profile: "probe", dshHome: home, run });
    expect(result.presetIncluded).toBe(false);
    expect(result.warnings.join("\n")).toMatch(/prompt-level restriction/);
  });

  it("errors on a missing profile directory", async () => {
    const home = mkdtempSync(join(tmpdir(), "odf-install-dsh-empty-"));
    await expect(
      installDshProfile({ profile: "nope", dshHome: home, run: vi.fn() }),
    ).rejects.toThrow(/profile directory not found/);
  });

  it("detects a stale installed package without ./dsh", async () => {
    const home = makeProfile(HEADER);
    const dir = join(home, "profiles", "probe", "node_modules", "opencode-dev-framework");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "opencode-dev-framework", exports: { ".": "./dist/index.js" } }),
      "utf8",
    );
    const result = await installDshProfile({
      profile: "probe",
      dshHome: home,
      run: vi.fn(async () => dumpWithoutRegistry()),
    });
    expect(result.packageSupportsDsh).toBe(false);
    expect(result.warnings.join("\n")).toMatch(/predates DSH support/);
  });

  it("block builders round-trip", () => {
    const block = buildManagedBlock("opencode-dev-framework/dsh", ["tools"]);
    expect(block).toContain(ODF_MANAGED_BEGIN);
    expect(hasHandMaintainedEntry(`${HEADER}${block}`)).toBe(false);
    expect(hasHandMaintainedEntry(`${HEADER}- id: odf-gates\n`)).toBe(true);
    const merged = upsertManagedBlock(null, block);
    expect(merged).toBe(block);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
