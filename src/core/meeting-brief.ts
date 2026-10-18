import { normaliseName, normaliseSubject } from "./meeting-key";
import type { MeetingIdentity } from "./meeting-match";
import type { MeetingRecord } from "./meeting-memory";

// The brief Luna reads on every turn of a meeting: who and what the meeting is, what the last ones decided, and notes that
// connected tools found. It is built once per meeting and cached by the caller. Bounded so it never crowds out the transcript.

/** The whole brief, in characters. Luna's prompt cuts it again to this limit. */
export const MEETING_BRIEF_MAX = 2000;
export const PAST_LIMIT = 4;
const AGENDA_MAX = 500;
const ATTENDEES_SHOWN = 8;
const PAST_ITEMS = 3;
const NOTE_MAX = 280;
const NOTES_MAX = 4;
const CARD_LINE_MAX = 110;

export type MeetingBrief = {
  /** The block for Luna's prompt. */
  text: string;
  /** Up to two short lines for the island at meeting start. Empty when there is nothing from before. */
  card: string[];
  /** How many earlier meetings and related notes the brief holds. For numbers-only logs. */
  counts: { past: number; notes: number };
};

const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value);
const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();

function sharedAttendees(a: readonly string[], b: readonly string[]): number {
  const known = new Set(a.map(normaliseName).filter((name) => name.length > 0));
  return new Set(b.map(normaliseName).filter((name) => known.has(name))).size;
}

/**
 * Earlier meetings worth recalling, newest first within two groups: the same meeting (same subject or key), then meetings with
 * the same people (two shared names, or one when the meeting has a single named attendee). Capped at `limit`.
 */
export function pastMeetings(args: {
  records: readonly MeetingRecord[];
  identity: Pick<MeetingIdentity, "key" | "subject" | "attendees">;
  limit?: number;
}): Array<{ record: MeetingRecord; reason: "same" | "people" }> {
  const { records, identity } = args;
  const subject = normaliseSubject(identity.subject);
  const needed = Math.min(2, new Set(identity.attendees.map(normaliseName).filter((name) => name.length > 0)).size);
  // Newest first. Records are stored oldest first, with equal dates in saved order.
  const newest = [...records].reverse().sort((a, b) => b.date.localeCompare(a.date));
  const same = newest.filter((record) => record.key === identity.key || (subject.length > 0 && normaliseSubject(record.subject) === subject));
  const sameIds = new Set(same.map((record) => record.id));
  const people = needed === 0 ? [] : newest.filter((record) => !sameIds.has(record.id) && sharedAttendees(identity.attendees, record.attendees) >= needed);
  return [
    ...same.map((record) => ({ record, reason: "same" as const })),
    ...people.map((record) => ({ record, reason: "people" as const })),
  ].slice(0, args.limit ?? PAST_LIMIT);
}

const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "will", "have", "are", "was", "our", "you", "your", "all", "can", "any", "not", "but", "please"]);

/** Up to `count` of the longest-used words in an agenda, for a search query. */
export function agendaKeywords(agenda: string, count = 5): string[] {
  const freq = new Map<string, number>();
  for (const word of agenda.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []) {
    if (!STOP.has(word)) freq.set(word, (freq.get(word) ?? 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, count).map(([word]) => word);
}

/** One search string for connected tools: the title, then up to three attendee names, then agenda keywords. At most 240 characters. */
export function searchQuery(identity: Pick<MeetingIdentity, "subject" | "attendees" | "agenda">): string {
  const names = identity.attendees.slice(0, 3).map((name) => name.replace(/<[^>]*>/g, "").trim());
  return clip([identity.subject, ...names, ...agendaKeywords(identity.agenda)].filter((part) => part.length > 0).join(" "), 240);
}

function dateLabel(date: string): string {
  const parsed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!parsed) return date;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(parsed[3])} ${months[Number(parsed[2]) - 1] ?? ""}`.trim();
}

function pastBlock(entry: { record: MeetingRecord; reason: "same" | "people" }): string {
  const { record } = entry;
  const head = `- ${dateLabel(record.date)}, ${record.subject || "meeting"}${entry.reason === "people" ? " (same people)" : ""}`;
  const parts = [
    record.decisions.length > 0 ? `decided: ${record.decisions.slice(0, PAST_ITEMS).join("; ")}` : "",
    record.actionItems.length > 0 ? `actions: ${record.actionItems.slice(0, PAST_ITEMS).join("; ")}` : "",
    record.decisions.length === 0 && record.actionItems.length === 0 && record.summary ? `topics: ${clip(record.summary, 240)}` : "",
  ].filter((part) => part.length > 0);
  return parts.length > 0 ? `${head}: ${parts.join(". ")}` : head;
}

/** Up to two island lines: when you last met and what was open. Empty with no earlier meeting. */
export function cardLines(past: ReadonlyArray<{ record: MeetingRecord; reason: "same" | "people" }>): string[] {
  const first = past[0];
  if (!first) return [];
  const { record } = first;
  const who =
    first.reason === "same" ? `Last time in ${record.subject || "this meeting"}` : `Last time with ${record.attendees.slice(0, 2).join(" and ") || "these people"}`;
  const line1 = `${who} (${dateLabel(record.date)})`;
  const detail = record.actionItems[0] ? `Open: ${record.actionItems[0]}` : record.decisions[0] ? `Decided: ${record.decisions[0]}` : record.summary ? clip(record.summary, 100) : "";
  return [clip(line1, CARD_LINE_MAX), ...(detail ? [clip(oneLine(detail), CARD_LINE_MAX)] : [])];
}

/**
 * The brief for a meeting. Past meetings and the agenda come first (they are the user's own record), then notes from connected
 * tools. With nothing at all it is two short lines that say so. Calendar and tool text is data for the model, not instructions.
 */
export function buildBrief(args: { identity: MeetingIdentity; past: ReturnType<typeof pastMeetings>; notes: readonly string[] }): MeetingBrief {
  const { identity, past } = args;
  const notes = args.notes.map((note) => clip(oneLine(note), NOTE_MAX)).filter((note) => note.length > 0).slice(0, NOTES_MAX);
  const when = identity.start && identity.end ? `, ${identity.start.slice(11, 16)}–${identity.end.slice(11, 16)} UTC` : "";
  const lines = [`Meeting: ${identity.subject || "unnamed"} (${identity.source === "calendar" ? "from the Outlook calendar" : "from the Teams window title"}${when})`];
  if (identity.organizer) lines.push(`Organiser: ${identity.organizer}`);
  if (identity.attendees.length > 0) {
    const shown = identity.attendees.slice(0, ATTENDEES_SHOWN);
    const more = identity.attendees.length - shown.length;
    lines.push(`Attendees: ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`);
  }
  if (identity.agenda) lines.push(`Agenda: ${clip(oneLine(identity.agenda), AGENDA_MAX)}`);
  if (past.length > 0) lines.push("Earlier meetings (newest first):", ...past.map(pastBlock));
  if (notes.length > 0) lines.push("Related notes from connected tools:", ...notes.map((note) => `- ${note}`));
  if (past.length === 0 && notes.length === 0) lines.push("No earlier meetings or related notes found.");
  return { text: clip(lines.join("\n"), MEETING_BRIEF_MAX), card: cardLines(past), counts: { past: past.length, notes: notes.length } };
}
