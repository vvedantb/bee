import { homedir } from "node:os";
import { browseCandidates, browseInstallCommand, parseBrowseStatus, type BrowseStatus } from "../core/browse";
import { debugLog } from "../core/debug-log";
import { executable, runFile } from "./binary";

// Main's side of OpenCode Browse (core/browse.ts): find the `browse` binary, ask it whether the browser extension is connected, and
// run the official installer from Settings. The Claude Code session attaches it by path (main/claude-code.ts), so the next request
// after an install has it. A status is kept for a short while; Settings → Check again asks afresh.

const STATUS_FOR_MS = 30_000;
const CHECK_MS = 10_000;
// `browse session list` starts a stopped relay: give it time to come up.
const WAKE_MS = 20_000;
// The installer downloads browse, opens the Chrome Web Store and waits for the extension to pair: minutes.
const INSTALL_MS = 10 * 60_000;

export type Browse = {
  /** The binary's path now, or null when it is not installed. Cheap: file checks only. */
  path: () => string | null;
  /** Where Browse stands. `fresh` skips the cached result and wakes a stopped relay first (Settings → Check again). */
  status: (fresh?: boolean) => Promise<BrowseStatus>;
  /** Runs the official installer (one at a time), then checks again. `error` when it failed and Browse is still missing. */
  install: () => Promise<{ status: BrowseStatus; error: string | null }>;
};

/** The last line of a failed run's output, for the user. */
const lastLine = (text: string) => text.trim().split("\n").filter(Boolean).at(-1)?.slice(0, 200) ?? "unknown error";

export function createBrowse(options: { platform?: NodeJS.Platform; env?: Readonly<Record<string, string | undefined>>; home?: string } = {}): Browse {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  let cached: { status: BrowseStatus; at: number } | null = null;
  let installing: Promise<{ status: BrowseStatus; error: string | null }> | null = null;

  const path = () => browseCandidates({ platform, home, env }).find(executable) ?? null;

  /** `browse status --json`. Any failure reads as not connected. */
  async function read(found: string): Promise<{ relay: boolean; connected: boolean } | null> {
    return parseBrowseStatus((await runFile(found, ["status", "--json"], CHECK_MS)).stdout);
  }

  async function check(fresh: boolean): Promise<BrowseStatus> {
    const found = path();
    if (!found) return { state: "missing" };
    let seen = await read(found);
    // The relay stops when idle and starts on demand: on a fresh check, start it so a paired extension can connect.
    if (fresh && seen && !seen.relay) {
      await runFile(found, ["session", "list", "--json"], WAKE_MS);
      seen = await read(found);
    }
    return seen?.connected ? { state: "connected", path: found } : { state: "installed", path: found };
  }

  async function status(fresh = false): Promise<BrowseStatus> {
    if (!fresh && cached && Date.now() - cached.at < STATUS_FOR_MS) return cached.status;
    const found = await check(fresh);
    cached = { status: found, at: Date.now() };
    debugLog.info("ai", "browse", found);
    return found;
  }

  async function runInstall(): Promise<{ status: BrowseStatus; error: string | null }> {
    const command = browseInstallCommand(platform);
    debugLog.info("ai", "browse-install-start", { file: command.file });
    const result = await runFile(command.file, command.args, INSTALL_MS);
    debugLog.info("ai", "browse-install", { ok: result.ok, out: `${result.stdout}\n${result.stderr}`.slice(-2000) });
    const after = await status(true);
    const failed = !result.ok && after.state === "missing";
    return { status: after, error: failed ? `Browse could not install: ${lastLine(`${result.stdout}\n${result.stderr}`)}` : null };
  }

  return {
    path,
    status,
    install: () => {
      installing ??= runInstall().finally(() => {
        installing = null;
      });
      return installing;
    },
  };
}
