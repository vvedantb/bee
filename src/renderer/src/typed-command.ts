import type { TypedCommandOutcome } from "./store";

// Live → Manual test → "Talk to Bee (typed)": the label, the hint and the line after a typed request. Pure, so tests can call it.
// Kept apart from "Simulate meeting line" on purpose: that one adds a meeting line and never wakes Bee; this one goes through
// the wake word and request path like a mic phrase after speech-to-text. Neither tests the microphone or speech-to-text.

export const TYPED_COMMAND_TITLE = "Talk to Bee (typed)";
export const TYPED_COMMAND_PLACEHOLDER = "Bee, open Chrome";
export const TYPED_COMMAND_HINT =
  'Runs like a phrase you said to Bee: start with "Bee,". Typed, not heard: it does not test the microphone or speech-to-text, and it never joins the meeting.';
export const TYPED_COMMAND_NO_WAKE = 'Bee did not take that as a request. Start with "Bee," (for example: Bee, open Chrome).';
export const TYPED_COMMAND_WAKE_OFF = "Talking to Bee by name is off in Settings.";

/**
 * Whether the field empties after a submit: yes once Bee took the request (or there was nothing in it), so the next one starts
 * clean; no when Bee did not take it, so the user can add "Bee," and send it again.
 */
export function clearsTypedCommand(outcome: TypedCommandOutcome): boolean {
  return outcome === "taken" || outcome === "empty";
}

/** The line under the field after a typed request, or null when there is nothing to say (Bee took it, or it was empty). */
export function typedCommandNote(outcome: TypedCommandOutcome | null): string | null {
  if (outcome === "no-wake") return TYPED_COMMAND_NO_WAKE;
  if (outcome === "wake-off") return TYPED_COMMAND_WAKE_OFF;
  return null;
}
