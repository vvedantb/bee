import { isZoomCallTitle, parseMeetTitle } from "./agent-desktop-meeting";
import type { AutoSignals } from "./auto-meeting-detection";
import type { DetectorReading } from "./sync-controller";
import { TEAMS_IMAGES, isMeetingTitle, meetingCandidate, micAppKind, type WindowRow } from "./teams-heuristics";

// The signals for automatic meeting detection (core/auto-meeting-detection.ts), from what the OS already shows: process window
// titles and the microphone registry (Windows), or the meeting window reader's list (macOS). Pure; main/meeting-signals.ts
// runs the commands. A browser alone is never a meeting app: only a browser window titled like a Meet call is.

export const ZOOM_IMAGES = ["zoom.exe"];
export const BROWSER_IMAGES = ["chrome.exe", "msedge.exe", "firefox.exe", "brave.exe"];
/** Every image the Windows probe lists windows for. */
export const SIGNAL_IMAGES = [...TEAMS_IMAGES, ...ZOOM_IMAGES, ...BROWSER_IMAGES];

export const NO_SIGNALS: AutoSignals = { meetingAppPresent: false, inCallTitle: false, micInUseByMeetingApp: false, identity: null };

const has = (images: string[], row: WindowRow): boolean => images.includes(row.image.toLowerCase());

/**
 * Windows: window rows (tasklist) and the mic keys in use now (micInUseKeys). The mic counts only when the app holding it is a
 * meeting app that is present: Teams, Zoom, or a browser showing a Meet call. A music app or a plain browser tab never counts.
 */
export function windowsSignals(args: { windows: readonly WindowRow[]; micKeys: readonly string[] }): AutoSignals {
  const teams = args.windows.filter((row) => has(TEAMS_IMAGES, row));
  const zoom = args.windows.filter((row) => has(ZOOM_IMAGES, row));
  const meets = args.windows.filter((row) => has(BROWSER_IMAGES, row) && parseMeetTitle(row.title) !== null);
  const teamsCall = teams.find((row) => isMeetingTitle(row.title));
  const zoomCall = zoom.find((row) => isZoomCallTitle(row.title));
  const meet = meets[0] ? parseMeetTitle(meets[0].title) : null;

  const kinds = new Set(args.micKeys.map(micAppKind));
  const mic = (kinds.has("teams") && teams.length > 0) || (kinds.has("zoom") && zoom.length > 0) || (kinds.has("browser") && meets.length > 0);

  let identity: string | null = null;
  if (teamsCall) identity = meetingCandidate(teamsCall.title).key;
  else if (zoomCall) identity = "zoom meeting";
  else if (meet) identity = `google meet ${meet.name.toLowerCase()}`;
  return {
    meetingAppPresent: teams.length > 0 || zoom.length > 0 || meets.length > 0,
    inCallTitle: Boolean(teamsCall || zoomCall || meet),
    micInUseByMeetingApp: mic,
    identity,
  };
}

/** A call window the meeting window reader found (macOS and Windows): the app is open and its title reads like a call. */
export function readerSignals(reading: DetectorReading | null): AutoSignals {
  const first = reading?.meetings[0];
  if (!reading?.inMeeting && !first) return NO_SIGNALS;
  return { meetingAppPresent: true, inCallTitle: true, micInUseByMeetingApp: false, identity: first?.key ?? null };
}

/** Either source says so. A known identity from the title wins over none. */
export function mergeSignals(a: AutoSignals, b: AutoSignals): AutoSignals {
  return {
    meetingAppPresent: a.meetingAppPresent || b.meetingAppPresent,
    inCallTitle: a.inCallTitle || b.inCallTitle,
    micInUseByMeetingApp: a.micInUseByMeetingApp === true || b.micInUseByMeetingApp === true,
    identity: a.identity ?? b.identity ?? null,
  };
}
