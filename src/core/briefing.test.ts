import { describe, expect, it } from "vitest";
import { BRIEFING_LEAD_MS, briefingTask, dueBriefing } from "./briefing";
import type { CalendarEvent } from "./calendar";
import type { MeetingRecord } from "./meeting-memory";

const now = Date.parse("2026-11-06T13:58:30Z");
const event = (patch: Partial<CalendarEvent> = {}): CalendarEvent => ({
  subject: "Weekly sync",
  start: "2026-11-06T14:00:00.000Z",
  end: "2026-11-06T14:30:00.000Z",
  organizer: "Sam Lee",
  required: ["Sam Lee <sam@x.com>", "Priya Shah", "Aoife Byrne", "Krzysztof Nowak"],
  optional: [],
  location: "",
  body: "Q4 plan and hiring",
  ...patch,
});
const record: MeetingRecord = {
  id: "r1",
  key: "weekly sync@sam lee",
  subject: "Weekly sync",
  organizer: "Sam Lee",
  attendees: ["Sam Lee", "Priya Shah"],
  date: "2026-10-30",
  summary: "Q3 review",
  tips: [],
  decisions: ["Ship SSO in November"],
  actionItems: ["Priya: send the pricing deck", "Sam: book the venue"],
};

describe("dueBriefing", () => {
  it("briefs a meeting starting within two minutes: who, last time, and what was left open", () => {
    const briefing = dueBriefing({ events: [event()], now, shown: new Set(), records: [record], memoryOn: true });
    expect(briefing?.lines).toEqual([
      "In 2 min: Weekly sync with Sam Lee, Priya Shah, Aoife Byrne and 1 other",
      "Last time in Weekly sync (30 Oct)",
      "Open: Priya: send the pricing deck",
      "Open: Sam: book the venue",
    ]);
    expect(briefing?.key).toBe("Weekly sync@2026-11-06T14:00:00.000Z");
  });

  it("says so when nothing was saved, and leaves earlier meetings out while memory is off", () => {
    expect(dueBriefing({ events: [event()], now, shown: new Set(), records: [record], memoryOn: false })?.lines.slice(1)).toEqual(["Nothing saved from earlier meetings with them."]);
  });

  it("skips meetings too far ahead, already started, already shown, or with nobody else on them", () => {
    const base = { now, shown: new Set<string>(), records: [], memoryOn: true };
    expect(dueBriefing({ ...base, events: [event({ start: new Date(now + BRIEFING_LEAD_MS + 1000).toISOString() })] })).toBeNull();
    expect(dueBriefing({ ...base, events: [event({ start: new Date(now - 1000).toISOString() })] })).toBeNull();
    expect(dueBriefing({ ...base, events: [event({ required: [], optional: [] })] })).toBeNull();
    expect(dueBriefing({ ...base, events: [event()], shown: new Set(["Weekly sync@2026-11-06T14:00:00.000Z"]) })).toBeNull();
  });

  it("picks the soonest due meeting", () => {
    const soon = event({ subject: "Standup", start: "2026-11-06T13:59:00.000Z" });
    expect(dueBriefing({ events: [event(), soon], now, shown: new Set(), records: [], memoryOn: true })?.subject).toBe("Standup");
  });
});

describe("briefingTask", () => {
  it("asks for read-only research about the meeting and its people", () => {
    const briefing = dueBriefing({ events: [event()], now, shown: new Set(), records: [], memoryOn: true });
    if (!briefing) throw new Error("expected a briefing");
    const { title, task } = briefingTask(briefing);
    expect(title).toBe("Prepare for Weekly sync");
    expect(task).toContain("Sam Lee, Priya Shah");
    expect(task).toContain("Agenda from the invite: Q4 plan and hiring");
    expect(task).toContain("Read only: do not send, post, create or change anything.");
  });
});
