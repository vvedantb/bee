import { z } from "zod";
import { binaryCandidates, type FindArgs } from "./binary-path";

// OpenCode Browse (https://github.com/anomalyco/browse): a `browse` CLI and a Chromium extension that let the AI drive tabs in the
// user's real browser, with their logins. Bee attaches its stdio MCP server (`browse mcp`) to the Claude Code session
// (core/claude-agent.ts) when the binary is installed; its `execute` tool asks the user before a send, buy or delete
// (core/browse-gate.ts). Pure: main/browse.ts finds the binary, reads its status and runs the installer.

/** missing: no `browse` binary. installed: found, but no browser extension connected. connected: the extension answers. */
export type BrowseStatus = { state: "missing" } | { state: "installed"; path: string } | { state: "connected"; path: string };

/** The MCP server name: the same as the entry `browse install` writes, so Bee's replaces (never duplicates) the user's own. */
export const BROWSE_SERVER = "browse";
/** The tool that runs Playwright code in the user's browser, as Claude Code names it. */
export const BROWSE_EXECUTE = `mcp__${BROWSE_SERVER}__execute`;
/** The same tool as Bee names it in its history (core/claude-agent.ts beeToolName). */
export const BROWSE_EXECUTE_TOOL = `${BROWSE_SERVER}__execute`;

/** Where `browse` may be: BEE_BROWSE_PATH, PATH, then the installer's folder ($XDG_BIN_HOME, else ~/.local/bin). */
export function browseCandidates(args: FindArgs): string[] {
  const xdg = args.env.XDG_BIN_HOME?.trim();
  return binaryCandidates({ ...args, name: "browse", override: "BEE_BROWSE_PATH", installDirs: (_windows, join) => [...(xdg ? [xdg] : []), join(args.home, ".local", "bin")] });
}

// `browse status --json`: the relay may be stopped (it starts on demand), and then extension is null.
const statusSchema = z.object({ relay: z.object({ running: z.boolean() }), extension: z.object({ connected: z.boolean() }).nullable() });

/** What `browse status --json` printed: whether the relay runs and the extension is connected. Null when it is not that JSON. */
export function parseBrowseStatus(output: string): { relay: boolean; connected: boolean } | null {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    const parsed = statusSchema.safeParse(JSON.parse(output.slice(start, end + 1)));
    return parsed.success ? { relay: parsed.data.relay.running, connected: parsed.data.extension?.connected ?? false } : null;
  } catch {
    return null;
  }
}

/**
 * The official install command, run without a shell where possible. `--agent none`: the installer edits no agent's config (Bee
 * attaches the server itself). It installs `browse`, opens the Chrome Web Store for the extension and waits for it to pair. Fixed
 * strings only: nothing from the user goes in.
 */
export function browseInstallCommand(platform: NodeJS.Platform): { file: string; args: string[] } {
  if (platform === "win32") {
    return { file: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "& ([scriptblock]::Create((irm https://opencode.ai/browse/install.ps1))) --agent none"] };
  }
  return { file: "bash", args: ["-c", "curl -fsSL https://opencode.ai/browse/install | bash -s -- --agent none"] };
}

/** The SDK's stdio MCP server entry for the binary at `path`. */
export const browseMcpServer = (path: string): { type: "stdio"; command: string; args: string[] } => ({ type: "stdio", command: path, args: ["mcp"] });

/** Added to a request's rules when the session has Browse (core/direct-command.ts): websites go to the real browser. */
export const BROWSE_RULES = [
  "For a task on a website (read a page, search a site, fill a form, send a message or email in a web app), use the browse tools (mcp__browse__…): they drive tabs in the user's own browser, with their logins. This holds even where other rules say Bee cannot click, type or send, and instead of use_computer or Bee's screen tools for web pages. Desktop apps still use Bee's screen tools.",
  "When a step needs the user (a login, a 2FA code, a payment, a captcha), Browse hands the tab to them: say so in one line and wait for the result, never try to get around it.",
  "Bee asks the user before a browse step that sends, posts, buys, submits or deletes. If one is declined or refused, do not try it another way: say it was not done.",
].join("\n");
