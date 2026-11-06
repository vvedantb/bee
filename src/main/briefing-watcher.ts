import { BRIEFING_TICK_MS, dueBriefing, type Briefing } from "../core/briefing";
import type { CalendarReader } from "../core/calendar";
import { debugLog, errorData } from "../core/debug-log";
import type { MeetingContextSettings } from "../core/meeting-context";
import type { MeetingRecord } from "../core/meeting-memory";
import type { BriefingView } from "../shared/ipc";

// Checks today's calendar every BRIEFING_TICK_MS and sends the island a briefing a couple of minutes before each meeting
// (core/briefing.ts). Keeps the recent briefings so "Dig deeper" (main/meeting-ipc.ts) can find one by key. Off with meeting
// context or the calendar setting.

const KEPT = 10;

export type BriefingWatcher = { tick: () => Promise<void>; get: (key: string) => Briefing | undefined; stop: () => void };

export function createBriefingWatcher(deps: {
  calendar: CalendarReader;
  records: () => readonly MeetingRecord[];
  settings: () => MeetingContextSettings;
  send: (view: BriefingView) => void;
  now?: () => number;
}): BriefingWatcher {
  const now = deps.now ?? Date.now;
  const shown = new Set<string>();
  const briefings = new Map<string, Briefing>();
  let ticking = false;

  async function tick(): Promise<void> {
    const settings = deps.settings();
    if (ticking || !settings.enabled || !settings.calendar) return;
    ticking = true;
    try {
      const result = await deps.calendar.readToday(new Date(now()));
      if (!result.ok) return;
      const due = dueBriefing({ events: result.events, now: now(), shown, records: settings.memory ? deps.records() : [], memoryOn: settings.memory });
      if (!due) return;
      shown.add(due.key);
      briefings.set(due.key, due);
      for (const old of [...briefings.keys()].slice(0, Math.max(0, briefings.size - KEPT))) briefings.delete(old);
      // Numbers only: the subject and names stay out of the log.
      debugLog.info("meeting", "briefing", { lines: due.lines.length, attendees: due.attendees.length });
      deps.send({ key: due.key, lines: due.lines });
    } catch (error) {
      debugLog.warn("meeting", "briefing-failed", { error: errorData(error) });
    } finally {
      ticking = false;
    }
  }

  const timer = setInterval(() => void tick(), BRIEFING_TICK_MS);
  timer.unref?.();
  return { tick, get: (key) => briefings.get(key), stop: () => clearInterval(timer) };
}
