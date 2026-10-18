import { TEAMS_IMAGES, isMeetingTitle } from "./teams-heuristics";

// The meeting NAME from Teams window titles, for new Teams (ms-teams.exe) and classic Teams (teams.exe). Pure text work:
// the readers that list window titles (PowerShell on Windows, System Events on macOS) live in main/local-readers.ts.

export type WindowTitleRow = { image: string; title: string };
export type WindowTitleReader = { read: () => Promise<WindowTitleRow[]> };

export type TeamsTitle = {
  /** "Weekly Sync" from "Weekly Sync | Chat | Microsoft Teams". */
  name: string;
  /** meeting: the call or meeting window. chat: a meeting's chat tab, which may open outside a call. */
  view: "meeting" | "chat";
  /** True for names that say nothing about the meeting ("Meet now"), so they never match a calendar subject. */
  generic: boolean;
  /** The other party in "Call with Alice" or "Meeting with Bob". */
  person?: string;
};

// The app name Teams adds to every title, with the separator before it: "| Microsoft Teams", "– Microsoft Teams classic".
const APP_SUFFIX = /\s*[|–—-]\s*Microsoft Teams(?:\s+classic|\s*\([^)]*\))?\s*$/i;
const APP_ONLY = /^Microsoft Teams(?:\s+classic|\s*\([^)]*\))?$/i;

// Teams' own tabs. A title that starts with one is the app's main window, not a meeting.
const TAB_NAMES = new Set([
  "activity", "apps", "approvals", "calendar", "calls", "chat", "communities", "copilot", "files", "meet", "meetings",
  "more", "notifications", "onedrive", "people", "planner", "tasks", "teams", "viva engage", "viva insights",
]);
const CHAT_TABS = new Set(["chat"]);
const GENERIC_NAME = /^(meet now|meeting|call|new meeting|teams meeting|microsoft teams meeting|huddle)$/i;
const PERSON = /^(?:meeting|call|chat)\s+with\s+(.+)$/i;
const MAX_NAME = 200;

/** The meeting name in one Teams window title, or null for tabs, the bare app title and empty titles. */
export function parseTeamsTitle(title: string): TeamsTitle | null {
  const cleaned = title.replace(/[‎‏]/g, "").trim();
  if (!cleaned || cleaned === "N/A" || APP_ONLY.test(cleaned)) return null;
  const rest = cleaned.replace(APP_SUFFIX, "").trim();
  if (!rest) return null;
  const parts = rest.split("|").map((part) => part.trim()).filter((part) => part.length > 0);
  const name = (parts[0] ?? "").slice(0, MAX_NAME);
  if (!name || TAB_NAMES.has(name.toLowerCase())) return null;
  const view = parts.slice(1).some((part) => CHAT_TABS.has(part.toLowerCase())) ? "chat" : "meeting";
  const person = PERSON.exec(name)?.[1]?.trim();
  return { name, view, generic: GENERIC_NAME.test(name), ...(person ? { person } : {}) };
}

/** A Teams window whose full title reads like a call, by the same test as the in-call detector. */
export function isTeamsMeetingRow(row: WindowTitleRow): boolean {
  return TEAMS_IMAGES.includes(row.image.toLowerCase()) && isMeetingTitle(row.title) && parseTeamsTitle(row.title) !== null;
}

function rank(parsed: TeamsTitle, title: string): number {
  // Lower is better: a meeting window over a chat tab, a call-like title over a plain one, a named meeting over a generic one.
  return (parsed.view === "meeting" ? 0 : 4) + (isMeetingTitle(title) ? 0 : 2) + (parsed.generic ? 3 : 0);
}

/**
 * The meeting name for this moment. With inCall (Teams holds the mic, or a meeting window exists) any parsed title may be the
 * call, for example "Weekly Sync | Microsoft Teams". Without it only titles that read like a call count.
 */
export function currentTeamsTitle(rows: readonly WindowTitleRow[], inCall: boolean): TeamsTitle | null {
  let best: { parsed: TeamsTitle; score: number } | null = null;
  for (const row of rows) {
    if (!TEAMS_IMAGES.includes(row.image.toLowerCase())) continue;
    if (!inCall && !isMeetingTitle(row.title)) continue;
    const parsed = parseTeamsTitle(row.title);
    if (!parsed) continue;
    const score = rank(parsed, row.title);
    if (!best || score < best.score) best = { parsed, score };
  }
  return best?.parsed ?? null;
}

/** Rows from the PowerShell window-title script: a JSON object, an array, or nothing. Anything unreadable gives []. */
export function parseWindowTitleJson(text: string): WindowTitleRow[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.flatMap((item): WindowTitleRow[] => {
    if (typeof item !== "object" || item === null) return [];
    const { image, title } = item as Record<string, unknown>;
    return typeof image === "string" && typeof title === "string" && title.trim() ? [{ image, title }] : [];
  });
}

/** Rows from the macOS script: one window name per line, all from the named process. */
export function parseWindowNameLines(text: string, image = "ms-teams.exe"): WindowTitleRow[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((title) => ({ image, title }));
}
