// The only meeting words Bee shows: a start toast, an end toast and the notch / Live line. No React or window here, so tests can call it.

/** The notch and Live tab line while a meeting is active. */
export const MEETING_IN_PROGRESS = "Meeting in progress";

export const MEETING_START_NOTICE = "Meeting in progress, Bee is active";
export const MEETING_START_NO_MIC_NOTICE = "Meeting in progress, but the microphone is unavailable.";

/** How the save ended: saved, failed, or nothing to save (no lines). */
export type MeetingEndOutcome = "saved" | "failed" | "none";

/** The end toast, shown once the save has finished. It claims notes only when they were saved. */
export function meetingEndNotice(outcome: MeetingEndOutcome): string {
  if (outcome === "saved") return "Meeting ended, notes have been saved";
  if (outcome === "failed") return "Meeting ended, but notes could not be saved.";
  return "Meeting ended.";
}
