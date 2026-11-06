import { app } from "electron";
import { join } from "node:path";
import { claudeAgent, type CommandAgent } from "../core/claude-agent";

// Main's side of core/claude-agent.ts: the agent for "Bee, …" requests, built per request from the user's Claude token so a new
// token in Settings applies at once. Bee keeps its own Claude Code folder in the user data folder: the user's own Claude Code
// login, settings and sessions are never read or changed.

/** The Claude Code binary as packaged (electron-builder extraResources → claude/). Undefined in development: the SDK finds its own. */
export function claudeExecutable(args: { packaged: boolean; resourcesPath: string; platform: NodeJS.Platform }): string | undefined {
  if (!args.packaged) return undefined;
  return join(args.resourcesPath, "claude", args.platform === "win32" ? "claude.exe" : "claude");
}

export function createCommandAgent(token: () => string | undefined): () => CommandAgent | null {
  const configDir = join(app.getPath("userData"), "claude");
  const executable = claudeExecutable({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, platform: process.platform });
  return () => {
    const value = token();
    return value ? claudeAgent({ token: value, configDir, ...(executable ? { executable } : {}) }) : null;
  };
}
