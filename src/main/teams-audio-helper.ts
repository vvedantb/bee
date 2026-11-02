import { existsSync } from "node:fs";
import { join } from "node:path";

// Where the Teams audio helper is (native/teams-audio). No Electron imports, so tests inject the paths and `exists`.
// The helper hears the Teams desktop app alone: WASAPI process loopback on the Teams process tree (Windows), ScreenCaptureKit
// filtered to the Teams app (macOS). Bee never ships or starts a helper that could record all system audio.

/** The folder under Resources (packaged) that build.win / build.mac extraResources copy the helper into. */
export const TEAMS_AUDIO_RESOURCE_DIR = "teams-audio";

export function teamsAudioHelperName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "teams-audio-helper.exe" : "teams-audio-helper";
}

/**
 * The build output folder for this platform and arch, under native/teams-audio/dist (scripts/build-teams-audio-*). Null where
 * Bee has no helper: Linux and anything else. Bee ships Windows x64 only; Windows on Arm runs that build under emulation.
 */
export function teamsAudioBuildDir(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) return `darwin-${arch}`;
  if (platform === "win32" && (arch === "x64" || arch === "arm64")) return `win32-${arch}`;
  return null;
}

/**
 * The helper binary, or null when this install has none. Packaged: Resources/teams-audio/teams-audio-helper[.exe] (kept out
 * of app.asar). Development: native/teams-audio/dist/<platform>-<arch>/ after `npm run build:teams-audio:win` or `:mac`.
 */
export function resolveTeamsAudioHelper(args: {
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
  platform?: NodeJS.Platform;
  arch?: string;
  exists?: (path: string) => boolean;
}): string | null {
  const platform = args.platform ?? process.platform;
  const exists = args.exists ?? existsSync;
  const dir = teamsAudioBuildDir(platform, args.arch ?? process.arch);
  if (!dir) return null;
  const name = teamsAudioHelperName(platform);
  const path = args.packaged ? join(args.resourcesPath, TEAMS_AUDIO_RESOURCE_DIR, name) : join(args.appPath, "native", "teams-audio", "dist", dir, name);
  return exists(path) ? path : null;
}
