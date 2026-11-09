import { isZoomCallTitle, parseMeetTitle } from "./agent-desktop-meeting";
import type { AutoSignals, TitleClass } from "./auto-meeting-detection";
import type { DetectorReading } from "./teams-heuristics";
import { TEAMS_IMAGES, isTeamsPreJoinTitle, meetingCandidate, micAppKind, type WindowRow } from "./teams-heuristics";
import { isTeamsInCallTitle } from "./teams-title";

// The signals for automatic meeting detection (core/auto-meeting-detection.ts), from what the OS already shows: process window
// titles and the microphone registry (Windows), or the meeting window reader's list (macOS). Pure; main/meeting-signals.ts
// runs the commands. A browser alone is never a meeting app: only a browser window titled like a Meet call is.

export const ZOOM_IMAGES = ["zoom.exe"];
export const BROWSER_IMAGES = ["chrome.exe", "msedge.exe", "firefox.exe", "brave.exe"];
/** Every image the Windows probe lists windows for. */
export const SIGNAL_IMAGES = [...TEAMS_IMAGES, ...ZOOM_IMAGES, ...BROWSER_IMAGES];

export const NO_SIGNALS: AutoSignals = { meetingAppPresent: false, inCallTitle: false, preJoinTitle: false, titleClass: "none", micInUseByMeetingApp: false, identity: null };

const has = (images: string[], row: WindowRow): boolean => images.includes(row.image.toLowerCase());

/**
 * Windows: window rows (tasklist) and the mic keys in use now (micInUseKeys). The mic counts only when the app holding it is a
 * meeting app that is present: Teams, Zoom, or a browser showing a Meet call. A music app or a plain browser tab never counts.
 */
export function windowsSignals(args: { windows: readonly WindowRow[]; micKeys: readonly string[] }): AutoSignals {
  const teams = args.windows.filter((row) => has(TEAMS_IMAGES, row));
  const zoom = args.windows.filter((row) => has(ZOOM_IMAGES, row));
  const meets = args.windows.filter((row) => has(BROWSER_IMAGES, row) && parseMeetTitle(row.title) !== null);
  const teamsCall = teams.find((row) => isTeamsInCallTitle(row.title));
  const teamsPreJoin = teams.find((row) => isTeamsPreJoinTitle(row.title));
  const zoomCall = zoom.find((row) => isZoomCallTitle(row.title));
  const meet = meets[0] ? parseMeetTitle(meets[0].title) : null;

  const kinds = new Set(args.micKeys.map(micAppKind));
  const mic = (kinds.has("teams") && teams.length > 0) || (kinds.has("zoom") && zoom.length > 0) || (kinds.has("browser") && meets.length > 0);

  let identity: string | null = null;
  if (teamsCall) identity = meetingCandidate(teamsCall.title).key;
  else if (zoomCall) identity = "zoom meeting";
  else if (meet) identity = `google meet ${meet.name.toLowerCase()}`;
  const inCallTitle = Boolean(teamsCall || zoomCall || meet);
  const preJoinTitle = !inCallTitle && Boolean(teamsPreJoin);
  // Teams windows with no readable title (tasklist "N/A") are "na"; windows that all read as tabs or chat are "chat".
  const readable = [...teams, ...zoom].filter((row) => row.title.trim() !== "" && row.title.trim() !== "N/A");
  const titleClass: TitleClass = inCallTitle ? "incall" : preJoinTitle ? "prejoin" : teams.length === 0 && zoom.length === 0 && meets.length === 0 ? "none" : readable.length > 0 ? "chat" : "na";
  return {
    meetingAppPresent: teams.length > 0 || zoom.length > 0 || meets.length > 0,
    inCallTitle,
    preJoinTitle,
    titleClass,
    micInUseByMeetingApp: mic,
    identity,
  };
}

/** A call window the meeting window reader found (macOS and Windows): the app is open and its title reads like a call. */
export function readerSignals(reading: DetectorReading | null): AutoSignals {
  const first = reading?.meetings[0];
  if (!reading?.inMeeting && !first) return NO_SIGNALS;
  return { meetingAppPresent: true, inCallTitle: true, preJoinTitle: false, titleClass: "incall", micInUseByMeetingApp: false, identity: first?.key ?? null };
}

const CLASS_ORDER: TitleClass[] = ["incall", "prejoin", "chat", "na", "none"];

/** Either source says so. A known identity from the title wins over none. */
export function mergeSignals(a: AutoSignals, b: AutoSignals): AutoSignals {
  const inCallTitle = a.inCallTitle || b.inCallTitle;
  const preJoinTitle = !inCallTitle && (a.preJoinTitle === true || b.preJoinTitle === true);
  const classes = [a.titleClass, b.titleClass].filter((value): value is TitleClass => value !== undefined);
  // The flags decide first; the sources' own classes only tell chat from na from none.
  const titleClass: TitleClass = inCallTitle ? "incall" : preJoinTitle ? "prejoin" : (CLASS_ORDER.find((value) => classes.includes(value)) ?? "none");
  return {
    meetingAppPresent: a.meetingAppPresent || b.meetingAppPresent,
    inCallTitle,
    preJoinTitle,
    titleClass,
    micInUseByMeetingApp: a.micInUseByMeetingApp === true || b.micInUseByMeetingApp === true,
    identity: a.identity ?? b.identity ?? null,
  };
}
