import type { CalendarEvent } from "./calendar";
import { meetingKey, normaliseSubject } from "./meeting-key";
import type { TeamsTitle } from "./teams-title";

// Which meeting the user is in now: a calendar event that overlaps now and fits the Teams window title, else the only event
// that overlaps now, else the window title alone.

export type MeetingIdentity = {
  /** calendar: an Outlook event. title: the Teams window title only. */
  source: "calendar" | "title";
  subject: string;
  organizer: string;
  attendees: string[];
  /** Agenda text, already truncated. Empty without a calendar event. */
  agenda: string;
  start?: string;
  end?: string;
  location?: string;
  recurring?: boolean;
  key: string;
};

/** An event counts from this long before it starts (people join early) until it ends. */
export const EARLY_JOIN_MS = 10 * 60_000;
/** Title and subject must share at least this much (Dice score) to count as the same meeting. */
export const TITLE_MATCH_MIN = 0.4;

const STOP_WORDS = new Set(["a", "an", "and", "the", "of", "to", "for", "with", "in", "on", "at", "microsoft", "teams", "meeting", "call", "re", "fw", "fwd"]);

function tokens(value: string): Set<string> {
  return new Set(normaliseSubject(value).split(" ").filter((token) => token.length > 0 && !STOP_WORDS.has(token)));
}

/** 0 to 1: how much two meeting names share, by words (Dice score). Empty names score 0. */
export function titleSimilarity(a: string, b: string): number {
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

export function overlapsNow(event: CalendarEvent, nowMs: number): boolean {
  return Date.parse(event.start) - EARLY_JOIN_MS <= nowMs && Date.parse(event.end) > nowMs;
}

function fromEvent(event: CalendarEvent): MeetingIdentity {
  const attendees = [...new Set([event.organizer, ...event.required, ...event.optional].filter((name) => name.length > 0))];
  return {
    source: "calendar",
    subject: event.subject,
    organizer: event.organizer,
    attendees,
    agenda: event.body,
    start: event.start,
    end: event.end,
    location: event.location,
    ...(event.recurring === undefined ? {} : { recurring: event.recurring }),
    key: meetingKey({ subject: event.subject, organizer: event.organizer, recurring: event.recurring }),
  };
}

function fromTitle(title: TeamsTitle): MeetingIdentity {
  return { source: "title", subject: title.name, organizer: "", attendees: title.person ? [title.person] : [], agenda: "", key: meetingKey({ subject: title.name }) };
}

/**
 * The current meeting, or null when there is no title and no event to go on.
 * 1. An overlapping event whose subject fits the title best (at least TITLE_MATCH_MIN).
 * 2. Otherwise the only overlapping event; with several, the best title fit, else the one that started most recently.
 * 3. Otherwise the title alone.
 */
export function matchMeeting(args: { title: TeamsTitle | null; events: readonly CalendarEvent[]; now: Date }): MeetingIdentity | null {
  const nowMs = args.now.getTime();
  const overlapping = args.events.filter((event) => overlapsNow(event, nowMs));
  const { title } = args;
  const scored = overlapping
    .map((event) => ({ event, score: title && !title.generic ? titleSimilarity(title.name, event.subject) : 0 }))
    // A better fit first; equal fits: the nearest start to now.
    .sort((a, b) => b.score - a.score || Math.abs(Date.parse(a.event.start) - nowMs) - Math.abs(Date.parse(b.event.start) - nowMs));
  const best = scored[0];
  if (best && best.score >= TITLE_MATCH_MIN) return fromEvent(best.event);
  if (best && (scored.length === 1 || !title || title.generic || best.score > 0)) return fromEvent(best.event);
  return title ? fromTitle(title) : null;
}
