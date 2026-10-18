import type { MeetingContextView } from "../shared/ipc";
import { guardCalendarReader, type CalendarEvent, type CalendarReader } from "./calendar";
import { buildBrief, pastMeetings, searchQuery, type MeetingBrief } from "./meeting-brief";
import { normaliseSubject } from "./meeting-key";
import { matchMeeting, type MeetingIdentity } from "./meeting-match";
import type { MeetingMemoryStore, MeetingRecord } from "./meeting-memory";
import { IDLE_TRACKER, stepTracker, type MeetingTracker } from "./meeting-tracker";
import { extractSummaryFields } from "./summary";
import { currentTeamsTitle, isTeamsMeetingRow, type WindowTitleReader, type WindowTitleRow } from "./teams-title";

// Which meeting the user is in, and what Bee knows about it. Window titles say Teams is in a call and name it; the Outlook
// calendar (when readable) adds attendees and agenda; saved meetings and connected tools add history. Everything is read on
// this device. The brief is built once per meeting and handed to Luna on every turn.

export type MeetingContextSettings = { enabled: boolean; calendar: boolean; memory: boolean };

export type MeetingContextDeps = {
  /** The existing in-call reading (Teams holds the mic, or shows a call window). Cheap and cached by its owner. */
  inCall: () => Promise<boolean>;
  titles: WindowTitleReader;
  calendar: CalendarReader;
  memory: MeetingMemoryStore;
  /** Related notes from connected tools for a query. Fails open to []. */
  searchNotes: (query: string) => Promise<string[]>;
  settings: () => MeetingContextSettings;
  now?: () => number;
  /** Read window titles even when the in-call detector says no (macOS has no in-call detector). */
  pollTitlesWhenIdle?: boolean;
  timing?: Partial<typeof DEFAULT_TIMING>;
};

export const DEFAULT_TIMING = {
  enterMs: 10_000,
  leaveMs: 15_000,
  /** Window titles are read at most this often. */
  titleMs: 30_000,
  /** The calendar is read at most this often, or after CALENDAR_CHANGE_MS when the window title changed. */
  calendarMs: 5 * 60_000,
  calendarChangeMs: 60_000,
};

type ActiveMeeting = {
  id: number;
  identity: MeetingIdentity | null;
  brief: MeetingBrief | null;
  /** Notes from connected tools, kept so the brief can be rebuilt (memory cleared or switched off) without searching again. */
  notes: string[];
  ended: boolean;
};

const HISTORY = 4;

function sameMeeting(a: MeetingIdentity, b: MeetingIdentity): boolean {
  return a.key === b.key || normaliseSubject(a.subject) === normaliseSubject(b.subject);
}

/** Local date as YYYY-MM-DD. */
function localDate(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export type MeetingContext = {
  /** Steps detection (cheap when nothing changed) and returns what the renderer needs. */
  tick: () => Promise<MeetingContextView>;
  /** The brief for the meeting in progress, for Luna. Undefined with no meeting, no name, or the feature off. */
  brief: () => string | undefined;
  /** Saves a finished meeting to local memory. False when off, or when the meeting has no name. */
  remember: (args: { meetingId?: number; summaryMarkdown: string; usedLlm: boolean; tips: readonly string[] }) => boolean;
  /** Deletes all saved meetings. Returns how many. */
  clearMemory: () => number;
};

export function createMeetingContext(deps: MeetingContextDeps): MeetingContext {
  const timing = { ...DEFAULT_TIMING, ...deps.timing };
  const clock = deps.now ?? Date.now;
  const calendar = guardCalendarReader(deps.calendar);

  let tracker: MeetingTracker = IDLE_TRACKER;
  let trackerEpoch = 0;
  let rows: WindowTitleRow[] = [];
  let rowsAt = -Infinity;
  let titleName = "";
  let events: CalendarEvent[] = [];
  let eventsAt = -Infinity;
  let counter = 0;
  let current: ActiveMeeting | null = null;
  const recent: ActiveMeeting[] = [];
  // A different meeting must be seen twice in a row before it replaces the current one (a title can flap, for example to a chat).
  let pending: { key: string; seen: number } | null = null;
  // Briefs by meeting key for this session: the same meeting again reuses its brief instead of searching again.
  const briefs = new Map<string, { brief: MeetingBrief; notes: string[] }>();
  let busy = false;
  // The memory switch the briefs were built with. Switching it off rebuilds them without earlier meetings.
  let briefMemory = deps.settings().memory;

  /** Earlier meetings for a brief: none while meeting memory is off. */
  const pastFor = (identity: MeetingIdentity) => (deps.settings().memory ? pastMeetings({ records: deps.memory.list(), identity }) : []);

  /** Rebuilds the briefs of the current and recent meetings from memory as it is now, keeping their tool notes. */
  function rebuildBriefs(): void {
    briefs.clear();
    for (const meeting of [current, ...recent]) {
      if (!meeting?.identity) continue;
      meeting.brief = buildBrief({ identity: meeting.identity, past: pastFor(meeting.identity), notes: meeting.notes });
    }
  }

  const view = (settings: MeetingContextSettings): MeetingContextView => {
    const meeting = current;
    return {
      enabled: settings.enabled,
      active: settings.enabled && tracker.stable && meeting !== null && !meeting.ended,
      id: meeting?.id ?? 0,
      subject: meeting?.identity?.subject ?? null,
      source: meeting?.identity?.source ?? "none",
      card: meeting?.brief?.card ?? [],
    };
  };

  function endCurrent(): void {
    if (current) current.ended = true;
    pending = null;
  }

  function begin(identity: MeetingIdentity | null): ActiveMeeting {
    if (current) {
      current.ended = true;
      recent.push(current);
      if (recent.length > HISTORY) recent.shift();
    }
    const meeting: ActiveMeeting = { id: ++counter, identity: null, brief: null, notes: [], ended: false };
    current = meeting;
    pending = null;
    if (identity) adopt(meeting, identity);
    return meeting;
  }

  /** Gives a meeting its identity and builds its brief: earlier meetings at once, then connected tools' notes. */
  function adopt(meeting: ActiveMeeting, identity: MeetingIdentity): void {
    meeting.identity = identity;
    const cached = briefs.get(identity.key);
    if (cached) {
      meeting.brief = cached.brief;
      meeting.notes = cached.notes;
      return;
    }
    const started = performance.now();
    const past = pastFor(identity);
    meeting.notes = [];
    meeting.brief = buildBrief({ identity, past, notes: [] });
    void deps
      .searchNotes(searchQuery(identity))
      .catch(() => [] as string[])
      .then((notes) => {
        // The meeting may have moved on while tools answered. Its brief still goes in the cache for a later return.
        // Memory may have been cleared or switched off while tools answered: read it again.
        const brief = buildBrief({ identity, past: pastFor(identity), notes });
        briefs.set(identity.key, { brief, notes });
        if (meeting.identity === identity) {
          meeting.brief = brief;
          meeting.notes = notes;
        }
        console.debug(`perf meeting-brief past=${brief.counts.past} notes=${brief.counts.notes} ms=${Math.round(performance.now() - started)}`);
      });
  }

  async function readTitles(now: number, wanted: boolean): Promise<void> {
    if (!wanted || now - rowsAt < timing.titleMs) return;
    rowsAt = now;
    rows = await deps.titles.read().catch(() => []);
  }

  async function readCalendar(now: number, enabled: boolean, name: string): Promise<void> {
    if (!enabled) {
      // Switched off: forget what was read, so matching falls back to the window title. Read afresh if switched on again.
      events = [];
      eventsAt = -Infinity;
      return;
    }
    const age = now - eventsAt;
    const changed = name !== titleName;
    if (age < (changed ? timing.calendarChangeMs : timing.calendarMs)) return;
    eventsAt = now;
    const started = performance.now();
    const result = await calendar.readToday(new Date(now));
    if (result.ok) {
      events = result.events;
      console.debug(`perf calendar events=${events.length} ms=${Math.round(performance.now() - started)}`);
    } else {
      // Disabled for the session: the guard answers without touching Outlook again.
      events = [];
      console.debug(`perf calendar disabled ms=${Math.round(performance.now() - started)}`);
    }
  }

  async function step(): Promise<MeetingContextView> {
    const settings = deps.settings();
    if (!settings.enabled) {
      if (current) endCurrent();
      tracker = IDLE_TRACKER;
      return view(settings);
    }
    if (settings.memory !== briefMemory) {
      briefMemory = settings.memory;
      rebuildBriefs();
    }
    const now = clock();
    const detected = await deps.inCall().catch(() => false);
    await readTitles(now, detected || deps.pollTitlesWhenIdle === true || tracker.raw);
    const raw = detected || rows.some(isTeamsMeetingRow);
    // Old readings do not name the next meeting. (macOS keeps polling, so it keeps its last reading.)
    if (!raw && !tracker.stable && !deps.pollTitlesWhenIdle) {
      rows = [];
      rowsAt = -Infinity;
    }
    tracker = stepTracker(tracker, raw, now, { enterMs: timing.enterMs, leaveMs: timing.leaveMs });
    if (!tracker.stable) {
      if (current && !current.ended) endCurrent();
      return view(settings);
    }
    const title = currentTeamsTitle(rows, true);
    await readCalendar(now, settings.calendar, title?.name ?? "");
    titleName = title?.name ?? "";
    const identity = matchMeeting({ title, events, now: new Date(now) });

    // A new stable detection is a new meeting, even with the same name.
    if (tracker.epoch !== trackerEpoch) {
      trackerEpoch = tracker.epoch;
      begin(identity);
      return view(settings);
    }
    if (!current || current.ended) begin(identity);
    const meeting = current as ActiveMeeting;
    if (!identity) return view(settings);
    if (!meeting.identity) {
      adopt(meeting, identity);
    } else if (meeting.identity.source === "title" && identity.source === "calendar") {
      // The calendar knows more than the window title did (attendees, agenda).
      adopt(meeting, identity);
      pending = null;
    } else if (sameMeeting(meeting.identity, identity)) {
      pending = null;
    } else if (pending?.key === identity.key) {
      pending.seen += 1;
      if (pending.seen >= 2) begin(identity);
    } else {
      pending = { key: identity.key, seen: 1 };
    }
    return view(settings);
  }

  return {
    async tick() {
      // One step at a time: a slow Outlook or title read never stacks up behind the poll.
      if (busy) return view(deps.settings());
      busy = true;
      try {
        return await step();
      } catch {
        return view(deps.settings());
      } finally {
        busy = false;
      }
    },
    brief() {
      const settings = deps.settings();
      return settings.enabled && current && !current.ended ? current.brief?.text : undefined;
    },
    remember({ meetingId, summaryMarkdown, usedLlm, tips }) {
      const settings = deps.settings();
      if (!settings.enabled || !settings.memory) return false;
      const meeting = meetingId === undefined ? current : [current, ...recent].find((item) => item?.id === meetingId);
      const identity = meeting?.identity;
      if (!meeting || !identity?.subject) return false;
      const fields = extractSummaryFields(summaryMarkdown);
      const record: MeetingRecord = {
        id: `${clock().toString(36)}-${meeting.id}`,
        key: identity.key,
        subject: identity.subject,
        organizer: identity.organizer,
        attendees: identity.attendees,
        date: localDate(clock()),
        // The local summary lists transcript lines under Topics. Those are never kept.
        summary: usedLlm ? fields.topics.join("; ") : "",
        tips: [...tips],
        decisions: usedLlm ? fields.decisions : [],
        actionItems: usedLlm ? fields.actionItems : [],
      };
      deps.memory.add(record);
      return true;
    },
    clearMemory() {
      const count = deps.memory.clear();
      // The meeting in progress drops what it recalled too (its brief and its island card).
      rebuildBriefs();
      return count;
    },
  };
}



