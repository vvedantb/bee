import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeSession, type CommandAgent, type SessionStore } from "../core/claude-agent";
import { MIN_CLAUDE_CODE, claudeCandidates, claudeCodeMessage, parseClaudeVersion, parseLoggedIn, versionAtLeast, type ClaudeCodeStatus } from "../core/claude-code";
import { debugLog } from "../core/debug-log";
import { executable, runFile } from "./binary";

// Main's side of "Bee, …" requests: find the user's own Claude Code (core/claude-code.ts), check its version and login, and build
// the agent on it (core/claude-agent.ts). Bee ships no Claude Code and keeps no token: the install's own login is used, so a user who
// signs in to Claude Code is signed in for Bee too. A ready result is kept for a few minutes; any other is checked again on the next
// request, so installing, updating or signing in works without a restart. Requests share one Claude Code session for as long as
// Bee runs (core/claude-agent.ts claudeSession); its id is kept in `sessionDir`, so the next start resumes the conversation. OpenCode
// Browse (main/browse.ts) is attached when installed: when it appears, moves or goes, the next request starts a new process on the
// same session id, so it has (or drops) the browse tools and still resumes the conversation.

const READY_FOR_MS = 5 * 60_000;
const CHECK_MS = 10_000;
// `claude update` downloads the new version: give it time.
const UPDATE_MS = 5 * 60_000;

async function run(path: string, args: string[], timeout = CHECK_MS): Promise<{ ok: boolean; out: string }> {
  const result = await runFile(path, args, timeout);
  return { ok: result.ok, out: `${result.stdout}${result.ok ? "" : `\n${result.stderr}`}` };
}

export type ClaudeCode = {
  /** Where the install stands now. `fresh` skips the cached ready result (Settings → Check again). */
  status: (fresh?: boolean) => Promise<ClaudeCodeStatus>;
  /** The session on the user's Claude Code, or what the user must do first. */
  agent: () => Promise<{ agent: CommandAgent } | { error: string }>;
  /** Ends the session's Claude Code process (Bee quitting). The session id stays, so the next start resumes it. */
  close: () => void;
  /** Runs `claude update` on the install found (native or package manager, as Claude Code decides), then checks again. */
  update: () => Promise<{ status: ClaudeCodeStatus; error: string | null }>;
};

/** The session id in `dir`/session.json. A missing or bad file reads as none. */
function sessionStore(dir: string): SessionStore {
  const path = join(dir, "session.json");
  return {
    load: () => {
      try {
        const id: unknown = JSON.parse(readFileSync(path, "utf8")).id;
        return typeof id === "string" && id ? id : null;
      } catch {
        return null;
      }
    },
    save: (id) => {
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(path, JSON.stringify({ id }));
      } catch (error) {
        debugLog.warn("ai", "session-save-failed", { error: error instanceof Error ? error.message : String(error) });
      }
    },
  };
}

/**
 * `sessionDir`: Bee's own folder for the Claude Code session (its working folder, and the id to resume). `browsePath`: where the
 * `browse` binary is now, or null (main/browse.ts path), read per request.
 */
export function createClaudeCode(options: { sessionDir: string; browsePath?: () => string | null }): ClaudeCode {
  let session: { path: string; browse: string | null; agent: ReturnType<typeof claudeSession> } | null = null;
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
  async function update(): Promise<{ status: ClaudeCodeStatus; error: string | null }> {
    const before = await status(true);
    if (before.state === "missing") return { status: before, error: null };
    const result = await run(before.path, ["update"], UPDATE_MS);
    debugLog.info("ai", "claude-code-update", { ok: result.ok, out: result.out.slice(0, 2000) });
    const after = await status(true);
    const failed = !result.ok && after.state === "outdated";
    return { status: after, error: failed ? `Claude Code could not update: ${result.out.trim().split("\n").filter(Boolean).at(-1)?.slice(0, 200) ?? "unknown error"}` : null };
  }
  return {
    status,
    update,
    agent: async () => {
      const found = await status();
      if (found.state !== "ready") return { error: claudeCodeMessage(found) ?? "" };
      // One process per install and Browse path: a new path (moved, reinstalled, Browse just installed) starts its own process,
      // resuming the same conversation.
      const browse = options.browsePath?.() ?? null;
      if (session?.path !== found.path || session.browse !== browse) {
        if (session) debugLog.info("ai", "session-restart", { claude: session.path !== found.path, browse: Boolean(browse) });
        session?.agent.close();
        mkdirSync(options.sessionDir, { recursive: true });
        session = { path: found.path, browse, agent: claudeSession({ executable: found.path, cwd: options.sessionDir, store: sessionStore(options.sessionDir), browse }) };
      }
      return { agent: session.agent };
    },
    close: () => {
      session?.agent.close();
      session = null;
    },
  };
}
