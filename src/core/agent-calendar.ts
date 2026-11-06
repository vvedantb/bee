import { z } from "zod";
import type { CalendarEvent, CalendarReader, CalendarReadResult } from "./calendar";

// Today's calendar through the user's Claude Code and their own calendar tools (a Google or Outlook calendar MCP server), for a
// Mac, or a PC without classic Outlook. The ask is slow (seconds, a model call), so readToday never waits on it: it returns what
// it has and refreshes in the background. With no calendar tool it stops asking until the next day. Pure: main gives `ask`.

/** A fresh read at most this often. Meetings added during the day show up within this time. */
export const AGENT_CALENDAR_REFRESH_MS = 60 * 60_000;
/** After a failed ask (Claude Code missing, signed out, a timeout), try again after this. */
export const AGENT_CALENDAR_RETRY_MS = 15 * 60_000;
const EVENTS_MAX = 30;

export const AGENT_CALENDAR_SYSTEM = [
  "You read the user's calendar for Bee. Use only the user's own calendar tools (MCP servers). Read only: never create, change, accept or decline anything.",
  'Reply with JSON only, no prose and no code fence: {"events":[{"subject":"","start":"","end":"","organizer":"","attendees":[""],"agenda":""}]}',
  "start and end are ISO 8601 with a time zone. attendees are display names, without the user. agenda is at most 300 characters of the description, or empty.",
  'If no calendar tool is connected, reply {"none":true}. If the day has no events, reply {"events":[]}.',
].join("\n");

/** The request text for one day. */
export function agentCalendarPrompt(now: Date): string {
  return `List my calendar events for today (${now.toDateString()}, local time zone offset ${-now.getTimezoneOffset()} minutes), from now to the end of the day.`;
}

const answerSchema = z.union([
  z.object({ none: z.literal(true) }),
  z.object({
    events: z
      .array(
        z.object({
          subject: z.string().catch(""),
          start: z.string(),
          end: z.string().catch(""),
          organizer: z.string().catch(""),
          attendees: z.array(z.string()).catch([]),
          agenda: z.string().catch(""),
        }),
      )
      .catch([]),
  }),
]);

const clip = (value: string, max: number) => value.replace(/\s+/g, " ").trim().slice(0, max);

/** The AI's answer → events (UTC ISO times), "none" when there is no calendar tool, or null when it is not readable. */
export function parseAgentCalendar(text: string): CalendarEvent[] | "none" | null {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (!json) return null;
  let parsed: ReturnType<typeof answerSchema.safeParse>;
  try {
    parsed = answerSchema.safeParse(JSON.parse(json));
  } catch {
    return null;
  }
  if (!parsed.success) return null;
  if ("none" in parsed.data) return "none";
  const events: CalendarEvent[] = [];
  for (const event of parsed.data.events) {
    const start = Date.parse(event.start);
    if (Number.isNaN(start)) continue;
    const end = Date.parse(event.end);
    events.push({
      subject: clip(event.subject, 200),
      start: new Date(start).toISOString(),
      end: new Date(Number.isNaN(end) ? start : end).toISOString(),
      organizer: clip(event.organizer, 80),
      required: event.attendees.map((name) => clip(name, 80)).filter(Boolean).slice(0, 30),
      optional: [],
      location: "",
      body: clip(event.agenda, 1200),
    });
  }
  return events.slice(0, EVENTS_MAX);
}

/** A calendar reader over the AI. Never slow and never "disabled": it answers from its cache at once. */
export function createAgentCalendarReader(deps: { ask: (now: Date) => Promise<string>; onError?: (error: unknown) => void }): CalendarReader {
  let day = "";
  let events: CalendarEvent[] = [];
  // When the next ask may start.
  let nextAt = 0;
  let asking = false;

  async function refresh(now: Date): Promise<void> {
    asking = true;
    try {
      const found = parseAgentCalendar(await deps.ask(now));
      if (found === null) throw new Error("calendar answer was not JSON");
      if (found === "none") {
        events = [];
        // No calendar tool: ask again tomorrow (or after a restart, when the user may have connected one).
        nextAt = Infinity;
        return;
      }
      events = found;
      nextAt = now.getTime() + AGENT_CALENDAR_REFRESH_MS;
    } catch (error) {
      deps.onError?.(error);
      nextAt = now.getTime() + AGENT_CALENDAR_RETRY_MS;
    } finally {
      asking = false;
    }
  }

  return {
    readToday: async (now = new Date()): Promise<CalendarReadResult> => {
      const today = now.toDateString();
      if (today !== day) {
        day = today;
        events = [];
        nextAt = 0;
      }
      if (!asking && now.getTime() >= nextAt) void refresh(now);
      return { ok: true, events };
    },
  };
}

/** The first reader while it works; once it says it cannot (not Windows, no Outlook), the second one from then on. */
export function fallbackCalendarReader(primary: CalendarReader, secondary: CalendarReader): CalendarReader {
  let useSecondary = false;
  return {
    readToday: async (now) => {
      if (!useSecondary) {
        const result = await primary.readToday(now);
        if (result.ok) return result;
        useSecondary = true;
      }
      return secondary.readToday(now);
    },
  };
}
