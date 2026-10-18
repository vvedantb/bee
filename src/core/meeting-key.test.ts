import { describe, expect, it } from "vitest";
import { meetingKey, normaliseName, normaliseSubject } from "./meeting-key";

describe("meetingKey", () => {
  it("ignores case, accents, punctuation, reply prefixes and the Teams suffix", () => {
    const base = meetingKey({ subject: "Weekly Sync", organizer: "Priya Nair" });
    expect(meetingKey({ subject: "  RE: weekly   sync! | Microsoft Teams", organizer: "priya  nair" })).toBe(base);
    expect(meetingKey({ subject: "Café Sync" })).toBe(meetingKey({ subject: "cafe sync" }));
  });

  it("includes the organiser, so two meetings with one name differ", () => {
    expect(meetingKey({ subject: "Sync", organizer: "Priya Nair" })).not.toBe(meetingKey({ subject: "Sync", organizer: "Sam Okafor" }));
  });

  it("ignores an address after the organiser's name", () => {
    expect(meetingKey({ subject: "Sync", organizer: "Priya Nair <priya@example.com>" })).toBe(meetingKey({ subject: "Sync", organizer: "Priya Nair" }));
  });

  it("marks a recurring series", () => {
    const one = meetingKey({ subject: "Sync", organizer: "P" });
    const series = meetingKey({ subject: "Sync", organizer: "P", recurring: true });
    expect(series).toBe(`${one}#r`);
    expect(meetingKey({ subject: "Sync", organizer: "P", recurring: false })).toBe(one);
  });

  it("is stable for a title-only meeting", () => {
    expect(meetingKey({ subject: "Meeting with Bob" })).toBe("meeting with bob@-");
  });

  it("normalises names and subjects on their own", () => {
    expect(normaliseSubject("Weekly Sync – Microsoft Teams")).toBe("weekly sync");
    expect(normaliseName("Smith, Alice (Guest)")).toBe("smith alice");
  });
});
