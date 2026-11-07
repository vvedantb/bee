import type { CalendarEvent } from "./calendar";
import { cardLines, pastMeetings, searchQuery } from "./meeting-brief";
import { meetingKey } from "./meeting-key";
import type { MeetingRecord } from "./meeting-memory";

// Before each meeting: a short card in the island a couple of minutes before it starts, with who is on it, when you last met and
// what was left open. Built from today's calendar (Outlook, or the user's calendar tools through Claude Code: core/agent-calendar.ts)
// and saved meetings (core/meeting-memory.ts). "Dig deeper" hands the rest to a background task. Pure: main runs the timer.

/** The card shows this long before the start. main checks every BRIEFING_TICK_MS, so it lands within one tick of this. */
export const BRIEFING_LEAD_MS = 2 * 60_000;
export const BRIEFING_TICK_MS = 30_000;
const NAMES_SHOWN = 3;
const OPEN_ITEMS = 2;
const LINE_MAX = 110;

export type Briefing = {
  /** One per event: its subject and start. */
  key: string;
  subject: string;
  /** ISO 8601, UTC. */
  start: string;
  attendees: string[];
  agenda: string;
  /** The island card. */
  lines: string[];
};

const clip = (value: string) => (value.length > LINE_MAX ? `${value.slice(0, LINE_MAX - 1).trimEnd()}…` : value);
const plainName = (name: string) => name.replace(/<[^>]*>/g, "").trim();

/** "Sam Lee, Priya Shah and 3 others". */
function namesLabel(names: readonly string[]): string {
  const shown = names.slice(0, NAMES_SHOWN).map(plainName);
  const more = names.length - shown.length;
  if (more > 0) return `${shown.join(", ")} and ${more} other${more === 1 ? "" : "s"}`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : (shown[0] ?? "");
}

/**
 * The briefing to show now, or null. An event is due once it starts within BRIEFING_LEAD_MS and has not started yet. Events with
 * nobody else on them (focus time, reminders) and events already shown are skipped.
 */
export function dueBriefing(args: {
  events: readonly CalendarEvent[];
  now: number;
  shown: ReadonlySet<string>;
  records: readonly MeetingRecord[];
}): Briefing | null {
  const upcoming = args.events
    .map((event) => ({ event, startMs: Date.parse(event.start) }))
    .filter(({ startMs }) => startMs > args.now && startMs - args.now <= BRIEFING_LEAD_MS)
    .sort((a, b) => a.startMs - b.startMs);
  for (const { event, startMs } of upcoming) {
    const key = `${event.subject}@${event.start}`;
    const attendees = [...event.required, ...event.optional].filter((name) => plainName(name).length > 0);
    if (args.shown.has(key) || attendees.length === 0) continue;
    const identity = { key: meetingKey({ subject: event.subject, organizer: event.organizer, recurring: event.recurring }), subject: event.subject, attendees };
    const past = pastMeetings({ records: args.records, identity });
    const minutes = Math.max(1, Math.ceil((startMs - args.now) / 60_000));
    const open = [...new Set(past.flatMap(({ record }) => record.actionItems))].slice(0, OPEN_ITEMS);
    const lastTime = cardLines(past)[0];
    const lines = [
      `In ${minutes} min: ${event.subject || "a meeting"} with ${namesLabel(attendees)}`,
      ...(lastTime ? [lastTime] : ["Nothing saved from earlier meetings with them."]),
      ...open.map((item) => `Open: ${item}`),
    ].map(clip);
    return { key, subject: event.subject, start: event.start, attendees, agenda: event.body, lines };
  }
  return null;
}

/** The background task behind "Dig deeper": read-only research in the user's connected tools. */
export function briefingTask(briefing: Briefing): { title: string; task: string } {
  const time = new Date(briefing.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return {
    title: `Prepare for ${briefing.subject || "the next meeting"}`,
    task: [
      `The user has "${briefing.subject || "a meeting"}" at ${time} with ${briefing.attendees.map(plainName).join(", ")}.`,
      briefing.agenda ? `Agenda from the invite: ${briefing.agenda}` : "",
      `Search the user's connected tools (email, chat, tasks, documents) and Bee's memory for the last two weeks of threads, open items and files about this meeting or these people. A good search: ${searchQuery({ subject: briefing.subject, attendees: briefing.attendees, agenda: briefing.agenda })}`,
      "Read only: do not send, post, create or change anything.",
      "Reply with what the user should know going in: open questions, promises made to or by them, and anything new since they last met.",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}
