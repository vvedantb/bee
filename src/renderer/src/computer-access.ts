import type { ComputerAccessView } from "../../shared/ipc";

// Settings → computer use: the Accessibility and Screen Recording lines. Pure, so tests can call it.

export const ACCESS_UNSUPPORTED = "Bee uses apps for you on Windows and Mac only.";
export const ACCESS_NEEDS_ACCESSIBILITY = "Turn on Bee in Accessibility settings so it can use apps for you.";
export const ACCESS_NEEDS_SCREEN_RECORDING = "Turn on Bee in Screen Recording settings so it can look at your screen when a request needs it.";

/**
 * What macOS still has to allow, or that this OS has no computer use. Null when there is nothing to do, or before the first check.
 * Only Accessibility: computer use reads the accessibility tree and never takes a picture, so Screen Recording plays no part.
 */
export function computerAccessMessage(access: ComputerAccessView | null | undefined): string | null {
  if (!access) return null;
  if (!access.supported) return ACCESS_UNSUPPORTED;
  if (access.accessibility === "denied") return ACCESS_NEEDS_ACCESSIBILITY;
  return null;
}

/** macOS only: look_at_screen (core/screen-look.ts) needs Screen Recording for Bee. Null when it has it, or before the first check. */
export function screenRecordingMessage(access: ComputerAccessView | null | undefined): string | null {
  if (!access?.supported || access.platform !== "mac") return null;
  return access.screenRecording === "denied" ? ACCESS_NEEDS_SCREEN_RECORDING : null;
}
