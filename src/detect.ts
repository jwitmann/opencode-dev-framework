/**
 * Project auto-detection for `df init`.
 *
 * Detects the dominant language, test/typecheck/format/lint commands, and
 * pre-commit availability by inspecting files in the project root. All
 * detection is synchronous and side-effect free; callers decide what to do
 * with the result.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandsConfig } from "./types.js";

export interface DetectionResult {
  /** Dominant language or framework detected from root files. */
  language: string | null;
  /** Suggested commands config for the project. */
  commands: CommandsConfig;
  /** True when a `.pre-commit-config.yaml` file is present. */
  hasPreCommitConfig: boolean;
}

function fileExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function readJsonSafe(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function hasAny(files: string[], names: string[]): boolean {
  return names.some((name) => files.includes(name));
}

/**
 * Detect project tooling by scanning the directory root.
 */
export function detectProject(directory: string): DetectionResult {
  const files = readdirSync(directory);

  const has = {
    packageJson: fileExists(join(directory, "package.json")),
    goMod: fileExists(join(directory, "go.mod")),
    cargoToml: fileExists(join(directory, "Cargo.toml")),
    pyProject: fileExists(join(directory, "pyproject.toml")),
    requirements: fileExists(join(directory, "requirements.txt")),
    gemfile: fileExists(join(directory, "Gemfile")),
    composerJson: fileExists(join(directory, "composer.json")),
    pomXml: fileExists(join(directory, "pom.xml")),
    gradle: hasAny(files, ["build.gradle", "build.gradle.kts"]),
    mavenWrapper: fileExists(join(directory, "mvnw")),
    gradleWrapper: fileExists(join(directory, "gradlew")),
    tsConfig: fileExists(join(directory, "tsconfig.json")),
  };

  const result: DetectionResult = {
    language: null,
    commands: {},
    hasPreCommitConfig: fileExists(join(directory, ".pre-commit-config.yaml")),
  };

  if (has.packageJson) {
    result.language = "node";
    const pkg = readJsonSafe(join(directory, "package.json"));
    const scripts = pkg?.scripts ?? {};

    if (typeof (scripts as Record<string, string>).test === "string") {
      result.commands.test = "npm test";
    }
    if (has.tsConfig) {
      result.commands.typecheck = "npx tsc --noEmit";
    }
    const devDeps = {
      ...((pkg?.devDependencies ?? {}) as Record<string, string>),
      ...((pkg?.dependencies ?? {}) as Record<string, string>),
    };
    if ("prettier" in devDeps) {
      result.commands.format = "npx prettier --write {file}";
    }
    if ("eslint" in devDeps) {
      result.commands.lint = "npx eslint {file}";
    } else if ("biome" in devDeps) {
      result.commands.lint = "npx biome lint {file}";
    }
    return result;
  }

  if (has.goMod) {
    result.language = "go";
    result.commands.test = "go test ./...";
    result.commands.typecheck = "go build ./...";
    result.commands.format = "gofumpt -w {file}";
    result.commands.lint = "golangci-lint run {file}";
    return result;
  }

  if (has.pyProject || has.requirements) {
    result.language = "python";
    result.commands.test = "pytest";
    if (has.pyProject) {
      result.commands.typecheck = "mypy .";
    }
    result.commands.format = "black {file}";
    result.commands.lint = "flake8 {file}";
    return result;
  }

  if (has.cargoToml) {
    result.language = "rust";
    result.commands.test = "cargo test";
    result.commands.typecheck = "cargo check";
    result.commands.format = "cargo fmt";
    result.commands.lint = "cargo clippy";
    return result;
  }

  if (has.gemfile) {
    result.language = "ruby";
    result.commands.test = "bundle exec rake test";
    result.commands.format = "rubocop -A {file}";
    result.commands.lint = "rubocop {file}";
    return result;
  }

  if (has.composerJson) {
    result.language = "php";
    result.commands.test = "composer test";
    result.commands.format = "php-cs-fixer fix {file}";
    result.commands.lint = "phpstan analyse {file}";
    return result;
  }

  if (has.pomXml || has.gradle) {
    result.language = "java";
    if (has.mavenWrapper) {
      result.commands.test = "./mvnw test";
      result.commands.typecheck = "./mvnw compile";
    } else if (has.gradleWrapper) {
      result.commands.test = "./gradlew test";
      result.commands.typecheck = "./gradlew compileJava";
    } else if (has.pomXml) {
      result.commands.test = "mvn test";
      result.commands.typecheck = "mvn compile";
    } else {
      result.commands.test = "gradle test";
      result.commands.typecheck = "gradle compileJava";
    }
    return result;
  }

  return result;
}

/**
 * Build a YAML config string from a detection result. Only includes keys that
 * have a detected value.
 */
export function detectedConfigYaml(language: string | null, commands: CommandsConfig): string {
  const lines: string[] = [];
  lines.push("profile: standard");
  if (language !== null) {
    lines.push(`# Detected language: ${language}`);
  }
  if (Object.keys(commands).length > 0) {
    lines.push("commands:");
    if (commands.test !== undefined) lines.push(`  test: ${commands.test}`);
    if (commands.typecheck !== undefined) lines.push(`  typecheck: ${commands.typecheck}`);
    if (commands.format !== undefined) {
      if (typeof commands.format === "string") {
        lines.push(`  format: ${commands.format}`);
      } else {
        lines.push("  format:");
        for (const [ext, cmd] of Object.entries(commands.format)) {
          lines.push(`    ${ext}: ${cmd}`);
        }
      }
    }
    if (commands.lint !== undefined) {
      if (typeof commands.lint === "string") {
        lines.push(`  lint: ${commands.lint}`);
      } else {
        lines.push("  lint:");
        for (const [ext, cmd] of Object.entries(commands.lint)) {
          lines.push(`    ${ext}: ${cmd}`);
        }
      }
    }
    if (commands.test_changed !== undefined) lines.push(`  test_changed: ${commands.test_changed}`);
  }
  return lines.join("\n");
}
