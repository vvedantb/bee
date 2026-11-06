import { z } from "zod";

// The user's own Claude Code install, which "Bee, …" requests run on (core/claude-agent.ts). Bee ships no Claude Code binary: it
// uses the one the user installed, and that install's login. Pure: main/claude-code.ts runs the checks.

/**
 * The oldest Claude Code Bee runs on: the version the installed Agent SDK was built with (@anthropic-ai/claude-agent-sdk 0.3.318
 * ships Claude Code 2.1.318). Older versions may lack options Bee sends (adaptive thinking, effort, the dontAsk permission mode).
 * Raise it with the SDK.
 */
export const MIN_CLAUDE_CODE = "2.1.318";

export type ClaudeCodeStatus =
  | { state: "ready"; path: string; version: string }
  | { state: "missing" }
  | { state: "outdated"; path: string; version: string }
  | { state: "signed-out"; path: string; version: string };

export const CLAUDE_CODE_MISSING = "Install Claude Code and sign in to talk to Bee.";
export const CLAUDE_CODE_SIGNED_OUT = "Sign in to Claude Code to talk to Bee: run claude, then /login.";
export const claudeCodeOutdated = (version: string) => `Update Claude Code to talk to Bee (found ${version}, needs ${MIN_CLAUDE_CODE} or later).`;

/** What the user must do before "Bee, …" requests work, or null when they work. */
export function claudeCodeMessage(status: ClaudeCodeStatus): string | null {
  if (status.state === "missing") return CLAUDE_CODE_MISSING;
  if (status.state === "outdated") return claudeCodeOutdated(status.version);
  if (status.state === "signed-out") return CLAUDE_CODE_SIGNED_OUT;
  return null;
}

/**
 * Where Claude Code may be, in order: BEE_CLAUDE_PATH, then each PATH folder, then the folders installers use. An app started from
 * Finder or the Start menu does not get the shell's PATH, so the install folders are checked by name. Only native binaries and
 * Unix launchers: npm's Windows claude.cmd shim cannot be started without a shell.
 */
export function claudeCandidates(args: { platform: NodeJS.Platform; home: string; env: Readonly<Record<string, string | undefined>> }): string[] {
  const windows = args.platform === "win32";
  const sep = windows ? "\\" : "/";
  const join = (...parts: string[]) => parts.join(sep);
  const name = windows ? "claude.exe" : "claude";
  const pathDirs = (args.env.PATH ?? args.env.Path ?? "").split(windows ? ";" : ":").filter(Boolean);
  const installDirs = windows
    ? [join(args.home, ".local", "bin"), ...(args.env.LOCALAPPDATA ? [join(args.env.LOCALAPPDATA, "Programs", "claude")] : [])]
    : [join(args.home, ".local", "bin"), join(args.home, ".claude", "local"), "/opt/homebrew/bin", "/usr/local/bin", join(args.home, ".npm-global", "bin"), join(args.home, ".bun", "bin")];
  const override = args.env.BEE_CLAUDE_PATH?.trim();
  return [...new Set([...(override ? [override] : []), ...[...pathDirs, ...installDirs].map((dir) => join(dir.replace(/[\\/]+$/, ""), name))])];
}

/** "2.1.318 (Claude Code)" → "2.1.318". */
export function parseClaudeVersion(output: string): string | null {
  return /(\d+)\.(\d+)\.(\d+)/.exec(output)?.[0] ?? null;
}

export function versionAtLeast(version: string, min: string): boolean {
  const parts = (value: string) => value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parts(version), parts(min)];
  for (let index = 0; index < 3; index++) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}

const authStatusSchema = z.object({ loggedIn: z.boolean() });

/** `claude auth status` prints JSON with loggedIn. Anything else counts as signed out. */
export function parseLoggedIn(output: string): boolean {
  try {
    return authStatusSchema.safeParse(JSON.parse(output)).data?.loggedIn ?? false;
  } catch {
    return false;
  }
}
