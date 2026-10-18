import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "./calendar";
import { matchMeeting, overlapsNow, titleSimilarity } from "./meeting-match";
import type { TeamsTitle } from "./teams-title";

const now = new Date("2026-10-17T14:10:00.000Z");
const event = (subject: string, start: string, end: string, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  subject,
  start: `2026-10-17T${start}:00.000Z`,
  end: `2026-10-17T${end}:00.000Z`,
  organizer: "Priya Nair",
  required: ["Sam Okafor"],
  optional: [],
  location: "",
  body: "Agenda text",
  ...extra,
});
const title = (name: string, extra: Partial<TeamsTitle> = {}): TeamsTitle => ({ name, view: "meeting", generic: false, ...extra });

describe("titleSimilarity", () => {
  it("scores shared words, ignoring case, stop words and the Teams suffix", () => {
    expect(titleSimilarity("Weekly Sync", "weekly sync | Microsoft Teams")).toBe(1);
    expect(titleSimilarity("Weekly Sync", "Weekly Sync – Platform team")).toBeGreaterThan(0.5);
    expect(titleSimilarity("Weekly Sync", "Budget review")).toBe(0);
    expect(titleSimilarity("", "Budget review")).toBe(0);
  });
});

describe("overlapsNow", () => {
  it("counts an event from 10 minutes before its start until its end", () => {
    expect(overlapsNow(event("A", "14:15", "14:45"), now.getTime())).toBe(true);
    expect(overlapsNow(event("A", "14:30", "15:00"), now.getTime())).toBe(false);
    expect(overlapsNow(event("A", "13:00", "14:10"), now.getTime())).toBe(false);
  });
});

describe("matchMeeting", () => {
  it("picks the overlapping event whose subject best fits the title", () => {
    const events = [event("Budget review", "14:00", "14:30"), event("Weekly Sync", "14:00", "14:45", { recurring: true })];
    const match = matchMeeting({ title: title("Weekly Sync"), events, now });
    expect(match).toMatchObject({ source: "calendar", subject: "Weekly Sync", organizer: "Priya Nair", recurring: true, agenda: "Agenda text" });
    expect(match?.attendees).toEqual(["Priya Nair", "Sam Okafor"]);
    expect(match?.key).toBe("weekly sync@priya nair#r");
  });

  it("falls back to the only overlapping event when the title fits nothing", () => {
    const match = matchMeeting({ title: title("Call with Alice"), events: [event("Dentist", "14:00", "14:30"), event("Later", "16:00", "17:00")], now });
    expect(match?.subject).toBe("Dentist");
  });

  it("falls back to the only overlapping event for a generic title", () => {
    expect(matchMeeting({ title: title("Meet now", { generic: true }), events: [event("Budget review", "14:00", "14:30")], now })?.subject).toBe("Budget review");
  });

  it("with several overlapping events and a generic title, takes the nearest start", () => {
    const events = [event("Early", "13:30", "14:30"), event("Near", "14:05", "14:45")];
    expect(matchMeeting({ title: title("Meet now", { generic: true }), events, now })?.subject).toBe("Near");
  });

  it("with several overlapping events and no fit, uses the title alone", () => {
    const events = [event("Early", "13:30", "14:30"), event("Near", "14:05", "14:45")];
    const match = matchMeeting({ title: title("Call with Alice", { person: "Alice" }), events, now });
    expect(match).toMatchObject({ source: "title", subject: "Call with Alice", attendees: ["Alice"], agenda: "" });
  });

  it("uses the title alone with no calendar events", () => {
    expect(matchMeeting({ title: title("Weekly Sync"), events: [], now })).toMatchObject({ source: "title", subject: "Weekly Sync", key: "weekly sync@-" });
  });

  it("ignores events that are not on now", () => {
    expect(matchMeeting({ title: title("Weekly Sync"), events: [event("Weekly Sync", "09:00", "09:30")], now })?.source).toBe("title");
  });

  it("uses an overlapping event with no title (mic only)", () => {
    expect(matchMeeting({ title: null, events: [event("Budget review", "14:00", "14:30")], now })?.subject).toBe("Budget review");
  });

  it("returns null with nothing to go on", () => {
    expect(matchMeeting({ title: null, events: [], now })).toBeNull();
  });
});
