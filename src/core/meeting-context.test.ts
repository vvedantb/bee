import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { record } from "../../test/helpers/meeting-records";
import type { CalendarEvent, CalendarReadResult, CalendarReader } from "./calendar";
import { createMeetingContext, type MeetingContextSettings } from "./meeting-context";
import { createMeetingMemoryStore, inMemoryFs } from "./meeting-memory";
import type { WindowTitleRow } from "./teams-title";

const T0 = Date.parse("2026-10-17T14:00:00.000Z");
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const weekly: CalendarEvent = {
  subject: "Weekly Sync",
  start: "2026-10-17T13:55:00.000Z",
  end: "2026-10-17T14:45:00.000Z",
  organizer: "Priya Nair",
  required: ["Priya Nair", "Sam Okafor"],
  optional: [],
  location: "",
  body: "Pipeline review and forecast",
  recurring: true,
};

function setup(options: { calendar?: CalendarReadResult; memory?: ReturnType<typeof inMemoryFs>; pollTitlesWhenIdle?: boolean } = {}) {
  const clock = { now: T0 };
  const inCall = { value: true };
  const titles: { rows: WindowTitleRow[] } = { rows: [{ image: "ms-teams.exe", title: "Weekly Sync | Microsoft Teams" }] };
  const settings: MeetingContextSettings = { enabled: true, calendar: true, memory: true };
  const readToday = vi.fn<CalendarReader["readToday"]>(async () => options.calendar ?? { ok: true, events: [weekly] });
  const readTitles = vi.fn(async () => titles.rows);
  const searchNotes = vi.fn(async (query: string) => {
    void query;
    return ["Acme asked for 20% off in June"];
  });
  const fs = options.memory ?? inMemoryFs();
  const memory = createMeetingMemoryStore({ path: "m.json", fs });
  const context = createMeetingContext({
    inCall: async () => inCall.value,
    titles: { read: readTitles },
    calendar: { readToday },
    memory,
    searchNotes,
    settings: () => settings,
    now: () => clock.now,
    pollTitlesWhenIdle: options.pollTitlesWhenIdle,
  });
  // Ticks every 5 s, like the renderer, for `seconds`.
  async function run(seconds: number) {
    let view = await context.tick();
    for (let spent = 0; spent < seconds; spent += 5) {
      clock.now += 5000;
      view = await context.tick();
    }
    await flush();
    return view;
  }
  return { context, clock, inCall, titles, settings, readToday, readTitles, searchNotes, memory, fs, run };
}

beforeEach(() => void vi.spyOn(console, "debug").mockImplementation(() => undefined));
afterEach(() => vi.restoreAllMocks());

describe("meeting context detection", () => {
  it("waits for a stable call, then names the meeting from the calendar event that fits the title", async () => {
    const t = setup();
    expect((await t.context.tick()).active).toBe(false);
    const view = await t.run(15);
    expect(view).toMatchObject({ enabled: true, active: true, id: 1, subject: "Weekly Sync", source: "calendar" });
    const brief = t.context.brief() ?? "";
    expect(brief).toContain("Attendees: Priya Nair, Sam Okafor");
    expect(brief).toContain("Agenda: Pipeline review and forecast");
    expect(brief).toContain("Acme asked for 20% off in June");
  });

  it("falls back to the window title when the calendar is unavailable", async () => {
    const t = setup({ calendar: { ok: false, disabled: true, reason: "not windows" } });
    const view = await t.run(15);
    expect(view).toMatchObject({ active: true, subject: "Weekly Sync", source: "title" });
    expect(t.context.brief()).toContain("from the Teams window title");
  });

  it("shows the earlier meeting in the card and the brief", async () => {
    const t = setup();
    t.memory.add(record(3, { key: "weekly sync@priya nair#r" }));
    const view = await t.run(15);
    expect(view.card).toEqual(["Last time in Weekly Sync (4 Oct)", "Open: Sam: send the quote"]);
    expect(t.context.brief()).toContain("decided: Ship SSO in Q4");
  });

  it("reads titles and the calendar sparingly across a long call", async () => {
    const t = setup();
    await t.run(400);
    expect(t.readTitles.mock.calls.length).toBeLessThanOrEqual(14);
    expect(t.readToday).toHaveBeenCalledTimes(2);
  });

  it("stops reading the calendar for the session after one failure", async () => {
    const t = setup({ calendar: { ok: false, disabled: true, reason: "security prompt timed out" } });
    await t.run(900);
    expect(t.readToday).toHaveBeenCalledTimes(1);
  });

  it("does not read the calendar when that switch is off", async () => {
    const t = setup();
    t.settings.calendar = false;
    const view = await t.run(30);
    expect(t.readToday).not.toHaveBeenCalled();
    expect(view.source).toBe("title");
  });

  it("does nothing when the master switch is off", async () => {
    const t = setup();
    t.settings.enabled = false;
    const view = await t.run(60);
    expect(view).toEqual({ enabled: false, active: false, id: 0, subject: null, source: "none", card: [] });
    expect(t.readTitles).not.toHaveBeenCalled();
    expect(t.context.brief()).toBeUndefined();
  });

  it("ends the meeting after the leave delay and keeps its id", async () => {
    const t = setup();
    await t.run(15);
    t.inCall.value = false;
    t.titles.rows = [];
    const view = await t.run(60);
    expect(view).toMatchObject({ active: false, id: 1 });
    expect(t.context.brief()).toBeUndefined();
  });

  it("gives a new id to the next call, but reuses the brief for the same meeting", async () => {
    const t = setup();
    await t.run(15);
    t.inCall.value = false;
    t.titles.rows = [];
    await t.run(60);
    t.inCall.value = true;
    t.titles.rows = [{ image: "ms-teams.exe", title: "Weekly Sync | Microsoft Teams" }];
    const view = await t.run(60);
    expect(view).toMatchObject({ active: true, id: 2, subject: "Weekly Sync" });
    expect(t.searchNotes).toHaveBeenCalledTimes(1);
    expect(t.context.brief()).toContain("Acme asked for 20% off");
  });

  it("switches meetings only after a different one is read twice in a row", async () => {
    const t = setup({ calendar: { ok: true, events: [] } });
    await t.run(15);
    t.titles.rows = [{ image: "ms-teams.exe", title: "Budget review | Microsoft Teams" }];
    // One reading of a different title: still Weekly Sync.
    t.clock.now += 31_000;
    expect((await t.context.tick()).subject).toBe("Weekly Sync");
    t.clock.now += 31_000;
    expect(await t.context.tick()).toMatchObject({ subject: "Budget review", id: 2 });
  });

  it("detects a call on macOS style polling, with no in-call reading", async () => {
    const t = setup({ pollTitlesWhenIdle: true });
    t.inCall.value = false;
    t.titles.rows = [{ image: "ms-teams.exe", title: "Meeting with Bob | Microsoft Teams" }];
    const view = await t.run(15);
    expect(view.active).toBe(true);
  });

  it("an unnamed call (mic only, no event) is active with no subject and no brief", async () => {
    const t = setup({ calendar: { ok: true, events: [] } });
    t.titles.rows = [];
    const view = await t.run(15);
    expect(view).toMatchObject({ active: true, subject: null, source: "none" });
    expect(t.context.brief()).toBeUndefined();
  });

  it("survives a failing title reader and search", async () => {
    const t = setup();
    t.readTitles.mockRejectedValue(new Error("boom"));
    t.searchNotes.mockRejectedValue(new Error("down"));
    const view = await t.run(15);
    expect(view.active).toBe(true);
  });
});

describe("remembering a meeting", () => {
  const markdown = "## Decisions\n- Ship SSO in Q4\n\n## Action items\n- Sam: send the quote\n\n## Topics\n- Pricing for Acme";

  it("saves the structured fields, the people and the tips", async () => {
    const t = setup();
    await t.run(15);
    expect(t.context.remember({ meetingId: 1, summaryMarkdown: markdown, usedLlm: true, tips: ["Ask about SSO"] })).toBe(true);
    expect(t.memory.list()).toHaveLength(1);
    expect(t.memory.list()[0]).toMatchObject({
      subject: "Weekly Sync",
      key: "weekly sync@priya nair#r",
      attendees: ["Priya Nair", "Sam Okafor"],
      date: "2026-10-17",
      summary: "Pricing for Acme",
      decisions: ["Ship SSO in Q4"],
      actionItems: ["Sam: send the quote"],
      tips: ["Ask about SSO"],
    });
  });

  it("saves a meeting after its call ended, by id", async () => {
    const t = setup();
    await t.run(15);
    t.inCall.value = false;
    t.titles.rows = [];
    await t.run(60);
    expect(t.context.remember({ meetingId: 1, summaryMarkdown: markdown, usedLlm: true, tips: [] })).toBe(true);
  });

  it("never keeps transcript lines from a summary written without AI", async () => {
    const t = setup();
    await t.run(15);
    t.context.remember({ meetingId: 1, summaryMarkdown: "## Topics\n- spoken words", usedLlm: false, tips: [] });
    expect(t.memory.list()[0]).toMatchObject({ summary: "", decisions: [], actionItems: [] });
  });

  it("saves nothing with memory off, the feature off, an unknown id, or no meeting name", async () => {
    const t = setup();
    await t.run(15);
    t.settings.memory = false;
    expect(t.context.remember({ meetingId: 1, summaryMarkdown: markdown, usedLlm: true, tips: [] })).toBe(false);
    t.settings.memory = true;
    expect(t.context.remember({ meetingId: 99, summaryMarkdown: markdown, usedLlm: true, tips: [] })).toBe(false);
    t.settings.enabled = false;
    expect(t.context.remember({ summaryMarkdown: markdown, usedLlm: true, tips: [] })).toBe(false);
    expect(t.memory.list()).toEqual([]);
  });

  it("clears every saved meeting and the cached briefs", async () => {
    const t = setup();
    t.memory.add(record(1));
    t.memory.add(record(2));
    expect(t.context.clearMemory()).toBe(2);
    expect(t.memory.list()).toEqual([]);
  });

  it("drops what the meeting in progress recalled when memory is cleared", async () => {
    const t = setup();
    t.memory.add(record(1));
    const before = await t.run(15);
    expect(before.card.length).toBeGreaterThan(0);
    expect(t.context.brief()).toContain("Ship SSO in Q4");
    t.context.clearMemory();
    expect(t.context.brief()).not.toContain("Ship SSO in Q4");
    // Tool notes are kept: nothing is searched again.
    expect(t.context.brief()).toContain("Acme asked for 20% off in June");
    expect(t.searchNotes).toHaveBeenCalledTimes(1);
    expect((await t.context.tick()).card).toEqual([]);
  });

  it("does not recall saved meetings while meeting memory is off", async () => {
    const t = setup();
    t.memory.add(record(1));
    t.settings.memory = false;
    const view = await t.run(15);
    expect(view.card).toEqual([]);
    expect(t.context.brief()).not.toContain("Ship SSO in Q4");
    t.settings.memory = true;
    expect((await t.context.tick()).card.length).toBeGreaterThan(0);
    expect(t.context.brief()).toContain("Ship SSO in Q4");
    t.settings.memory = false;
    await t.context.tick();
    expect(t.context.brief()).not.toContain("Ship SSO in Q4");
  });
});

describe("calendar re-read on a title change", () => {
  it("re-reads once the 60 s window has passed, even when the title changed inside it", async () => {
    const t = setup();
    await t.run(15);
    const reads = t.readToday.mock.calls.length;
    // 30 s after the read the title changes: too soon to read again.
    await t.run(30);
    t.titles.rows = [{ image: "ms-teams.exe", title: "Pricing Review | Microsoft Teams" }];
    await t.run(15);
    expect(t.readToday.mock.calls.length).toBe(reads);
    // Past 60 s since the read: the new title is read for, without waiting the full 5 minutes.
    await t.run(45);
    expect(t.readToday.mock.calls.length).toBe(reads + 1);
    // And then not again while the title stays the same.
    await t.run(60);
    expect(t.readToday.mock.calls.length).toBe(reads + 1);
  });
});

describe("calendar switch", () => {
  it("forgets calendar events when the calendar is switched off mid-session", async () => {
    const t = setup();
    expect((await t.run(15)).source).toBe("calendar");
    t.settings.calendar = false;
    // A new call: matching must not use the events read earlier.
    t.inCall.value = false;
    t.titles.rows = [];
    await t.run(30);
    t.inCall.value = true;
    t.titles.rows = [{ image: "ms-teams.exe", title: "Weekly Sync | Microsoft Teams" }];
    const calls = t.readToday.mock.calls.length;
    const view = await t.run(45);
    expect(view).toMatchObject({ active: true, source: "title" });
    expect(t.readToday.mock.calls.length).toBe(calls);
  });
});

describe("logging", () => {
  it("logs numbers only, never the meeting text", async () => {
    const debug = vi.mocked(console.debug);
    const t = setup();
    await t.run(15);
    const logged = debug.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toMatch(/perf calendar events=1 ms=\d+/);
    expect(logged).toMatch(/perf meeting-brief past=0 notes=1 ms=\d+/);
    expect(logged).not.toMatch(/Weekly|Priya|Acme|Pipeline/);
  });
});
