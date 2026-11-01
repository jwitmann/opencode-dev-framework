import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

/**
 * Anti-rot pin for `examples/`: every shipped example config must load.
 * Catches schema drift (a config key the validator rejects) and stale
 * copy-paste before users hit it.
 */
describe("examples", () => {
  const examplesDir = join(process.cwd(), "examples");
  const names = readdirSync(examplesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  // The pin is explicit: adding an example means adding it here.
  expect(names).toEqual(["go-service", "hardening", "node-service", "python-service"]);

  for (const name of names) {
    it(`${name} config loads with real checks`, () => {
      const dir = join(examplesDir, name);
      expect(existsSync(join(dir, ".opencode-dev-framework.yml"))).toBe(true);
      const config = loadConfig(dir);
      expect(config.profile).toBe("standard");
      expect(config.gate.run_tests).toBe(true);
      expect(config.commands.test).toBeTruthy();
    });
  }
});
