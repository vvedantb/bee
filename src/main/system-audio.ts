// System (meeting) audio is best-effort. The mic stays primary; this only reports whether a screen source exists.
import { desktopCapturer } from "electron";

type Source = { id: string };

/** Mic and screen capture are allowed; every other permission is denied. */
export function isPermissionAllowed(permission: string): boolean {
  return permission === "media" || permission === "display-capture";
}

/** The first screen source id, or null when there is none. */
export function pickScreenSource(sources: Source[]): string | null {
  return sources.find((source) => source.id.startsWith("screen:"))?.id ?? null;
}

/** Probes for a screen source. Any failure (no permission, no display) is "not available". */
export async function findSystemAudioSource(
  getSources: (options: { types: ["screen"] }) => Promise<Source[]> = (options) => desktopCapturer.getSources(options),
): Promise<string | null> {
  try {
    return pickScreenSource(await getSources({ types: ["screen"] }));
  } catch {
    return null;
  }
}
