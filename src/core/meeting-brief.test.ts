import { describe, expect, it } from "vitest";
import { record } from "../../test/helpers/meeting-records";
import { MEETING_BRIEF_MAX, agendaKeywords, buildBrief, cardLines, pastMeetings, searchQuery } from "./meeting-brief";
import type { MeetingIdentity } from "./meeting-match";

const identity = (extra: Partial<MeetingIdentity> = {}): MeetingIdentity => ({
  source: "calendar",
  subject: "Weekly Sync",
  organizer: "Priya Nair",
  attendees: ["Priya Nair", "Sam Okafor", "Vedant B"],
  agenda: "Pipeline review and forecast. Renewal for Acme.",
  start: "2026-10-17T13:00:00.000Z",
  end: "2026-10-17T13:30:00.000Z",
  key: "weekly sync@priya nair#r",
  ...extra,
});

describe("pastMeetings", () => {
  it("finds earlier meetings with the same key or subject, newest first", () => {
    const records = [record(3, { key: "weekly sync@priya nair#r" }), record(9, { key: "weekly sync@-", id: "title-only" }), record(5, { subject: "Other", key: "other@x", attendees: ["Zed"] })];
    const past = pastMeetings({ records, identity: identity() });
    expect(past.map((entry) => entry.record.id)).toEqual(["title-only", "r3"]);
    expect(past.every((entry) => entry.reason === "same")).toBe(true);
  });

  it("finds meetings with overlapping attendees after the same-meeting ones", () => {
    const records = [
      record(2, { subject: "Pricing", key: "pricing@sam", attendees: ["Sam Okafor", "Priya Nair", "Kim"] }),
      record(8, { subject: "Offsite", key: "offsite@x", attendees: ["Priya Nair"] }),
      record(4),
    ];
    const past = pastMeetings({ records, identity: identity() });
    expect(past.map((entry) => [entry.record.id, entry.reason])).toEqual([["r4", "same"], ["r2", "people"]]);
  });

  it("needs only one shared name when the meeting has one named attendee", () => {
    const records = [record(2, { subject: "Pricing", key: "pricing@sam", attendees: ["Alice", "Bob"] })];
    expect(pastMeetings({ records, identity: identity({ subject: "Call with Alice", key: "call with alice@-", attendees: ["Alice"] }) })).toHaveLength(1);
  });

  it("caps the list", () => {
    const records = Array.from({ length: 10 }, (_, n) => record(n + 1));
    expect(pastMeetings({ records, identity: identity() })).toHaveLength(4);
    expect(pastMeetings({ records, identity: identity(), limit: 2 })).toHaveLength(2);
  });

  it("returns nothing for a meeting never seen", () => {
    expect(pastMeetings({ records: [record(1)], identity: identity({ subject: "Brand new", key: "brand new@z", attendees: ["Nobody"] }) })).toEqual([]);
  });
});

describe("buildBrief", () => {
  it("includes the title, people, agenda, earlier decisions and tool notes", () => {
    const past = pastMeetings({ records: [record(3)], identity: identity() });
    const brief = buildBrief({ identity: identity(), past, notes: ["Acme asked for 20% off in June"] });
    expect(brief.text).toContain("Meeting: Weekly Sync (from the Outlook calendar");
    expect(brief.text).toContain("Organiser: Priya Nair");
    expect(brief.text).toContain("Attendees: Priya Nair, Sam Okafor, Vedant B");
    expect(brief.text).toContain("Agenda: Pipeline review and forecast.");
    expect(brief.text).toContain("decided: Ship SSO in Q4");
    expect(brief.text).toContain("actions: Sam: send the quote");
    expect(brief.text).toContain("- Acme asked for 20% off in June");
    expect(brief.counts).toEqual({ past: 1, notes: 1 });
  });

  it("with nothing found, says so in a short brief and has no card", () => {
    const brief = buildBrief({ identity: identity({ source: "title", attendees: [], agenda: "", organizer: "", start: undefined, end: undefined }), past: [], notes: [] });
    expect(brief.text).toContain("No earlier meetings or related notes found.");
    expect(brief.text.length).toBeLessThan(200);
    expect(brief.card).toEqual([]);
  });

  it("stays within the size limit however much it is given", () => {
    const records = Array.from({ length: 6 }, (_, n) => record(n + 1, { decisions: Array(10).fill("d".repeat(240)), actionItems: Array(10).fill("a".repeat(240)) }));
    const past = pastMeetings({ records, identity: identity() });
    const brief = buildBrief({
      identity: identity({ agenda: "agenda ".repeat(500), attendees: Array.from({ length: 30 }, (_, n) => `Person ${n}`) }),
      past,
      notes: Array(10).fill("n".repeat(1000)),
    });
    expect(brief.text.length).toBeLessThanOrEqual(MEETING_BRIEF_MAX);
    expect(brief.text).toContain("(+22 more)");
  });
});

describe("cardLines", () => {
  it("names the meeting and the first open action for the same meeting", () => {
    const lines = cardLines(pastMeetings({ records: [record(3)], identity: identity() }));
    expect(lines).toEqual(["Last time in Weekly Sync (4 Oct)", "Open: Sam: send the quote"]);
  });

  it("names the people for an attendee match", () => {
    const records = [record(2, { subject: "Pricing", key: "pricing@sam", attendees: ["Sam Okafor", "Priya Nair"], actionItems: [] })];
    const lines = cardLines(pastMeetings({ records, identity: identity() }));
    expect(lines[0]).toBe("Last time with Sam Okafor and Priya Nair (3 Oct)");
    expect(lines[1]).toBe("Decided: Ship SSO in Q4");
  });

  it("is empty with no earlier meeting and at most two short lines otherwise", () => {
    expect(cardLines([])).toEqual([]);
    const long = cardLines(pastMeetings({ records: [record(3, { actionItems: ["x".repeat(240)] })], identity: identity() }));
    expect(long).toHaveLength(2);
    expect(long.every((line) => line.length <= 110)).toBe(true);
  });
});

describe("search query", () => {
  it("pulls keywords from the agenda", () => {
    expect(agendaKeywords("Pipeline review and forecast. Pipeline risks. Renewal for Acme.", 3)).toEqual(["pipeline", "forecast", "renewal"]);
  });

  it("joins title, three attendees and keywords, within 240 characters", () => {
    const query = searchQuery(identity({ attendees: ["A One", "B Two", "C Three", "D Four"] }));
    expect(query.startsWith("Weekly Sync A One B Two C Three ")).toBe(true);
    expect(query).not.toContain("D Four");
    expect(searchQuery(identity({ agenda: "word ".repeat(200), subject: "s".repeat(300) })).length).toBeLessThanOrEqual(240);
  });
});
