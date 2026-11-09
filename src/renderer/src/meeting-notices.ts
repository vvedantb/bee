// The only meeting words Bee shows: start, prompt and stop toasts, an end toast and the notch / Live line. No React or window here, so tests can call it.

/** The notch and Live tab line while a meeting is active. */
export const MEETING_IN_PROGRESS = "Meeting in progress";

export const MEETING_START_NOTICE = "Meeting in progress, Bee is active";
export const MEETING_START_NO_MIC_NOTICE = "Meeting in progress, but the microphone is unavailable.";

/** Auto-confirm on, pre-join seen: Bee shows itself and waits for the call to begin before it records. */
export const MEETING_READY_NOTICE = "Meeting starting, Bee is getting ready";

/** Auto-confirm off: Bee has detected a call and asks first. The toast button starts the meeting. */
export const MEETING_PROMPT_NOTICE = "Meeting detected";
export const MEETING_START_BUTTON = "Start meeting";
/** Auto-confirm off, after Start: the persistent toast that carries the Stop button. */
export const MEETING_STOP_NOTICE = "Meeting in progress";
export const MEETING_STOP_BUTTON = "Stop meeting";
/** The one stable toast id: prompt, then stop control, then cleared. */
export const MEETING_TOAST_ID = "bee-meeting";

/**
 * What the store tells the UI. info: a plain toast. prompt-start / prompt-stop: a persistent toast with a button (Start meeting /
 * Stop meeting). clear: remove the persistent toast.
 */
export type MeetingNotice =
  | { kind: "info"; message: string }
  | { kind: "prompt-start"; message: string }
  | { kind: "prompt-stop"; message: string }
  | { kind: "clear" };

/** How the save ended: saved, failed, or nothing to save (no lines). */
export type MeetingEndOutcome = "saved" | "failed" | "none";

/** The end toast, shown once the save has finished. It claims notes only when they were saved. */
export function meetingEndNotice(outcome: MeetingEndOutcome): string {
  if (outcome === "saved") return "Meeting ended, notes have been saved";
  if (outcome === "failed") return "Meeting ended, but notes could not be saved.";
  return "Meeting ended.";
}
