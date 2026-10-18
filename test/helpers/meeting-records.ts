import type { MeetingRecord } from "../../src/core/meeting-memory";

// A saved meeting for tests. n sets the id and the day of the month.
export const record = (n: number, extra: Partial<MeetingRecord> = {}): MeetingRecord => ({
  id: `r${n}`,
  key: "weekly sync@priya nair",
  subject: "Weekly Sync",
  organizer: "Priya Nair",
  attendees: ["Priya Nair", "Sam Okafor"],
  date: `2026-10-${String((n % 28) + 1).padStart(2, "0")}`,
  summary: "Pipeline and renewals",
  tips: ["Ask about the SSO date"],
  decisions: ["Ship SSO in Q4"],
  actionItems: ["Sam: send the quote"],
  ...extra,
});
