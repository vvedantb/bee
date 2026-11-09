// Best-effort "desktop Teams is in a call" from things Windows already exposes: process window titles (tasklist)
// and the microphone privacy registry (which app is using the mic now). No Teams API, no Microsoft IDs.

export const TEAMS_IMAGES = ["ms-teams.exe", "teams.exe"];

export type WindowRow = { image: string; pid: number; title: string };

/** Rows of `tasklist /v /fo csv /nh`: image name first, window title last. */
export function parseTasklistCsv(text: string): WindowRow[] {
  const rows: WindowRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cells = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((match) => (match[1] ?? "").replace(/""/g, '"'));
    if (cells.length < 3) continue;
    rows.push({ image: cells[0] ?? "", pid: Number(cells[1]), title: cells[cells.length - 1] ?? "" });
  }
  return rows;
}

// Teams' own tabs that mention calls or meetings but are not a live call.
const NOT_A_CALL = /^(calls|calendar|meetings|activity|chat|teams|meet|home|files|apps|people|settings)\s*\|/i;
// A badge count before the title: "(3) Chat | Microsoft Teams".
const UNREAD_COUNT = /^\(\d+\)\s*/;

// New Teams' pre-join screen: "Meeting join | PD | Microsoft Teams". The user has not joined yet, so it is not a live call.
const PRE_JOIN = /^(?:meeting join|join (?:the )?meeting|join now)\b/i;

/** The Teams pre-join (lobby or device check) window, e.g. "Meeting join | PD". Not a live call: the user has not joined. */
export function isTeamsPreJoinTitle(title: string): boolean {
  return PRE_JOIN.test(title.trim().replace(UNREAD_COUNT, ""));
}

/** A Teams window whose title reads like a meeting or call window, e.g. "Meeting with Alice | Microsoft Teams". Pre-join is not one. */
export function isMeetingTitle(title: string): boolean {
  const trimmed = title.trim().replace(UNREAD_COUNT, "");
  if (!trimmed || trimmed === "N/A" || NOT_A_CALL.test(trimmed) || isTeamsPreJoinTitle(trimmed)) return false;
  return /\b(meeting|call|meet now|huddle)\b/i.test(trimmed);
}

/**
 * Registry keys (from `reg query …\ConsentStore\microphone /s`) whose app is using the mic now:
 * LastUsedTimeStart set and LastUsedTimeStop 0x0.
 */
export function micInUseKeys(text: string): string[] {
  const inUse: string[] = [];
  let key = "";
  let start = false;
  let stopZero = false;
  const flush = () => {
    if (key && start && stopZero) inUse.push(key);
  };
  for (const line of text.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line.trim())) {
      flush();
      key = line.trim();
      start = false;
      stopZero = false;
      continue;
    }
    const value = /^\s+(LastUsedTimeStart|LastUsedTimeStop)\s+REG_QWORD\s+(0x[0-9a-f]+)/i.exec(line);
    if (!value) continue;
    if (value[1]?.toLowerCase() === "lastusedtimestart") start = value[2] !== "0x0";
    else stopZero = value[2] === "0x0";
  }
  flush();
  return inUse;
}

export type MicApp = "teams" | "zoom" | "browser";

// The last path part of a ConsentStore key. NonPackaged apps encode their path with "#" for "\\"; packaged ones use the package name.
const BROWSER_EXE = /^(chrome|msedge|firefox|brave|opera|vivaldi|arc|zen)\.exe$/;

/** Which kind of app a mic registry key is: Teams (new, classic), Zoom, a browser (Google Meet runs there), or something else (null). */
export function micAppKind(key: string): MicApp | null {
  const name = (key.trim().split("\\").pop() ?? "").split("#").pop()?.toLowerCase() ?? "";
  if (/^(ms-?teams(\.exe)?|teams\.exe|msteams_\w+)$/.test(name)) return "teams";
  if (/^zoom(\.exe)?$/.test(name)) return "zoom";
  if (BROWSER_EXE.test(name)) return "browser";
  return null;
}

// One desktop meeting window. No Microsoft meeting id: the key is only the window's own title, normalised.
export type MeetingCandidate = { key: string; title: string; label: string };

// What the Teams detector reads: meetings are the named meeting windows open now (may be empty while inMeeting, e.g. a mic-only call).
export type DetectorReading = { inMeeting: boolean; source: "windows" | "none"; meetings: MeetingCandidate[] };

/** "Meeting with Bob | Microsoft Teams" → label "Meeting with Bob", key "meeting with bob". */
export function meetingCandidate(title: string): MeetingCandidate {
  const label = title.trim().replace(/\s*[|\u2013\u2014-]\s*Microsoft Teams\b.*$/i, "").trim() || title.trim();
  return { key: label.toLowerCase().replace(/\s+/g, " "), title, label };
}

/** Teams windows that read like a call, one per distinct title (a pop-out and the main window count once). */
export function meetingWindows(windows: WindowRow[]): MeetingCandidate[] {
  const found = new Map<string, MeetingCandidate>();
  for (const row of windows) {
    if (!TEAMS_IMAGES.includes(row.image.toLowerCase()) || !isMeetingTitle(row.title)) continue;
    const candidate = meetingCandidate(row.title);
    if (!found.has(candidate.key)) found.set(candidate.key, candidate);
  }
  return [...found.values()];
}

/** Teams is running and either holds the mic or shows a meeting window. */
export function teamsInMeeting(args: { windows: WindowRow[]; micKeys: string[] }): boolean {
  const teams = args.windows.filter((row) => TEAMS_IMAGES.includes(row.image.toLowerCase()));
  if (teams.length === 0) return false;
  const micByTeams = args.micKeys.some((key) => /teams/i.test(key));
  return micByTeams || meetingWindows(teams).length > 0;
}
