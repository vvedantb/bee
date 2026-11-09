// The only meeting words Bee shows: the pill's short notices and lines, the notch's Start / Stop meeting button and the Live line. No React or window here, so tests can call it.

/** The notch and Live tab line while a meeting is active. */
export const MEETING_IN_PROGRESS = "Meeting in progress";

export const MEETING_START_NOTICE = "Meeting in progress, Bee is active";
export const MEETING_START_NO_MIC_NOTICE = "Microphone unavailable";

/** Auto-confirm on, pre-join seen: Bee shows itself and waits for the call to begin before it records. */
export const MEETING_READY_NOTICE = "Meeting starting, Bee is getting ready";

/** Auto-confirm off: Bee has detected a call and asks first. The pill says so; the notch's Start meeting button starts it. */
export const MEETING_PROMPT_NOTICE = "Meeting detected";
/** Auto-confirm off: the notch button while a call waits (store.ts meetingPrompt "start"), then after Start ("stop"). */
export const MEETING_START_BUTTON = "Start meeting";
export const MEETING_STOP_BUTTON = "Stop meeting";

/** How the save ended: saved, failed, or nothing to save (no lines). */
export type MeetingEndOutcome = "saved" | "failed" | "none";

/** The end notice, shown once the save has finished. It claims notes only when they were saved. */
export function meetingEndNotice(outcome: MeetingEndOutcome): string {
  if (outcome === "saved") return "Meeting ended, notes have been saved";
  if (outcome === "failed") return "Meeting ended, but notes could not be saved.";
  return "Meeting ended.";
}
