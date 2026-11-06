import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { claudeAgent, type CommandAgent } from "../core/claude-agent";
import { MIN_CLAUDE_CODE, claudeCandidates, claudeCodeMessage, parseClaudeVersion, parseLoggedIn, versionAtLeast, type ClaudeCodeStatus } from "../core/claude-code";
import { debugLog } from "../core/debug-log";

// Main's side of "Bee, …" requests: find the user's own Claude Code (core/claude-code.ts), check its version and login, and build
// the agent on it (core/claude-agent.ts). Bee ships no Claude Code and keeps no token: the install's own login is used, so a user who
// signs in to Claude Code is signed in for Bee too. A ready result is kept for a few minutes; any other is checked again on the next
// request, so installing, updating or signing in works without a restart.

const READY_FOR_MS = 5 * 60_000;
const CHECK_MS = 10_000;

function run(path: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(path, args, { timeout: CHECK_MS, windowsHide: true }, (error, stdout) => resolve({ ok: !error, out: String(stdout) }));
  });
}

function executable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export type ClaudeCode = {
  /** Where the install stands now. `fresh` skips the cached ready result (Settings → Check again). */
  status: (fresh?: boolean) => Promise<ClaudeCodeStatus>;
  /** The agent on the user's Claude Code, or what the user must do first. */
  agent: () => Promise<{ agent: CommandAgent } | { error: string }>;
};

export function createClaudeCode(): ClaudeCode {
  let ready: { status: ClaudeCodeStatus; at: number } | null = null;
  async function check(): Promise<ClaudeCodeStatus> {
    const path = claudeCandidates({ platform: process.platform, home: homedir(), env: process.env }).find(executable);
    if (!path) return { state: "missing" };
    const version = parseClaudeVersion((await run(path, ["--version"])).out);
    if (!version) return { state: "missing" };
    if (!versionAtLeast(version, MIN_CLAUDE_CODE)) return { state: "outdated", path, version };
    const auth = await run(path, ["auth", "status"]);
    return parseLoggedIn(auth.out) ? { state: "ready", path, version } : { state: "signed-out", path, version };
  }
  async function status(fresh = false): Promise<ClaudeCodeStatus> {
    if (!fresh && ready && Date.now() - ready.at < READY_FOR_MS) return ready.status;
    const found = await check();
    ready = found.state === "ready" ? { status: found, at: Date.now() } : null;
    debugLog.info("ai", "claude-code", found);
    return found;
  }
  return {
    status,
    agent: async () => {
      const found = await status();
      if (found.state !== "ready") return { error: claudeCodeMessage(found) ?? "" };
      return { agent: claudeAgent({ executable: found.path }) };
    },
  };
}
