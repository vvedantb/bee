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
const NOT_A_CALL = /^(calls|calendar|meetings|activity|chat|teams|meet)\s*\|/i;

/** A Teams window whose title reads like a meeting or call window, e.g. "Meeting with Alice | Microsoft Teams". */
export function isMeetingTitle(title: string): boolean {
  const trimmed = title.trim();
  if (!trimmed || trimmed === "N/A" || NOT_A_CALL.test(trimmed)) return false;
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

/** Teams is running and either holds the mic or shows a meeting window. */
export function teamsInMeeting(args: { windows: WindowRow[]; micKeys: string[] }): boolean {
  const teams = args.windows.filter((row) => TEAMS_IMAGES.includes(row.image.toLowerCase()));
  if (teams.length === 0) return false;
  const micByTeams = args.micKeys.some((key) => /teams/i.test(key));
  return micByTeams || teams.some((row) => isMeetingTitle(row.title));
}
