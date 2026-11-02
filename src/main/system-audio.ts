// Bee never captures the screen or all system audio. The mic is primary; the Teams audio fallback captures the Teams app alone
// through the native helper (main/teams-audio-capture.ts), not Electron. This picks Teams' window, never a screen, for a future
// Electron `audio: 'application'` path (see ARCHITECTURE.md); nothing captures with it today.
import { desktopCapturer } from "electron";
import { isMeetingTitle } from "../core/teams-heuristics";
import { isTeamsWindowTitle, parseTeamsTitle } from "../core/teams-title";

type Source = { id: string; name: string };
type GetSources = (options: { types: ["window"]; thumbnailSize: { width: number; height: number }; fetchWindowIcons: boolean }) => Promise<Source[]>;

/** The microphone is allowed; every other permission, screen capture included, is denied. */
export function isPermissionAllowed(permission: string): boolean {
  return permission === "media";
}

/**
 * The Teams window source for a per-app capture: a call window first ("Meeting with Alice | Microsoft Teams"), then a named
 * meeting, then a chat, then any Teams window. desktopCapturer names a window by its title only (no process name such as
 * ms-teams.exe), so Teams is known by the "| Microsoft Teams" suffix. Never a screen source. Null when Teams shows no window.
 */
export function pickTeamsWindowSource(sources: readonly Source[]): string | null {
  let best: { id: string; rank: number } | null = null;
  for (const source of sources) {
    if (!source.id.startsWith("window:") || !isTeamsWindowTitle(source.name)) continue;
    const parsed = parseTeamsTitle(source.name);
    const rank = parsed && isMeetingTitle(source.name) ? 0 : parsed?.view === "meeting" ? 1 : parsed ? 2 : 3;
    if (!best || rank < best.rank) best = { id: source.id, rank };
  }
  return best?.id ?? null;
}

/** Lists windows (no thumbnails or icons) for the Teams one. Any failure (no permission, no Teams) is "none". */
export async function findTeamsWindowSource(getSources: GetSources = (options) => desktopCapturer.getSources(options)): Promise<string | null> {
  try {
    return pickTeamsWindowSource(await getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false }));
  } catch {
    return null;
  }
}
