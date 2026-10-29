import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearConfigCache, loadConfig } from "../src/config";
import { renderStatus } from "../src/format-status";

describe("renderStatus format honesty", () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "df-status-"));
    cleanup = () => rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    cleanup();
    clearConfigCache();
  });

  it("marks on_edit.format as reserved since no format runner exists", () => {
    writeFileSync(
      join(dir, ".opencode-dev-framework.yml"),
      ["profile: standard", "commands:", "  format: gofumpt -w {file}", ""].join("\n"),
    );
    const config = loadConfig(dir);
    const status = renderStatus(config);
    expect(status).toContain("format: true (ignored — formatting is OpenCode core's job)");
    expect(status).toContain("gofumpt -w {file}");
  });
});
