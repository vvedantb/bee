import { FOLLOW_UP_CONFIDENCE } from "./wake-word";

// The addressee check's settings (core/addressee-check.ts). Apart from it so Settings and the preload do not load the AI SDK.

/** Addressee check on by default: it is the one small check unclear phrases already got. Off sends such phrases to the meeting. */
export const ADDRESSEE_CHECK_DEFAULT = true;
/**
 * Bee acts on the model's "bee" verdict only at this confidence or more. 0.7 matches FOLLOW_UP_CONFIDENCE, the bar unclear
 * phrases already had. Wrongly cutting in on a call costs more than a missed follow-up (the user can say "Bee"), so the
 * default favours staying quiet: a failure, a timeout or a score below the bar is a meeting line.
 */
export const ADDRESSEE_THRESHOLD_DEFAULT = FOLLOW_UP_CONFIDENCE;
/** The Settings range: below 0.5 the model is guessing; above 0.95 it would almost never act. */
export const ADDRESSEE_THRESHOLD_MIN = 0.5;
export const ADDRESSEE_THRESHOLD_MAX = 0.95;

/** A saved threshold as a number in range. Anything else reads as the default. */
export function clampAddresseeThreshold(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return ADDRESSEE_THRESHOLD_DEFAULT;
  return Math.round(Math.min(ADDRESSEE_THRESHOLD_MAX, Math.max(ADDRESSEE_THRESHOLD_MIN, value)) * 100) / 100;
}
