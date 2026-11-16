/**
 * Host abstraction: how the plugin executes external commands.
 *
 * Unit tests inject a stubbed `RunCommand`; production wiring uses the
 * `runCommand` implementation below, which is compatible with both Node.js
 * and Bun (OpenCode loads plugins under Bun).
 */

import { spawn } from "node:child_process";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when the process was killed because it exceeded the timeout. */
  timedOut: boolean;
}

export interface RunCommandOptions {
  cwd?: string;
  /** Timeout in seconds. The process is killed (SIGTERM) when exceeded. */
  timeout?: number;
}

export type RunCommand = (command: string[], options?: RunCommandOptions) => Promise<CommandResult>;

/**
 * Execute a command without a shell, capturing stdout/stderr.
 *
 * Never rejects: spawn failures resolve with exitCode 127 so callers can
 * treat "tool missing" like any other command failure.
 */
export const runCommand: RunCommand = (command, options = {}) =>
  new Promise((resolve) => {
    const [cmd, ...args] = command;
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const finish = (result: CommandResult) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolve(result);
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { cwd: options.cwd });
    } catch (error) {
      finish({ stdout, stderr: String(error), exitCode: 127, timedOut });
      return;
    }

    if (options.timeout !== undefined && options.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, options.timeout * 1000);
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      finish({ stdout, stderr: stderr + String(error), exitCode: 127, timedOut });
    });
    child.on("close", (code) => {
      finish({ stdout, stderr, exitCode: code ?? 1, timedOut });
    });
  });
