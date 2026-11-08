import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";

// Running a command-line tool the user installed (Claude Code, main/claude-code.ts; OpenCode Browse, main/browse.ts): no shell.

/** A file that exists and may be run (any file on Windows, where there is no execute bit). */
export function executable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Runs `file` with `args` and no shell. Never throws: a failure, a non-zero exit or the timeout is ok false. */
export function runFile(file: string, args: readonly string[], timeout: number): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr) }));
  });
}
