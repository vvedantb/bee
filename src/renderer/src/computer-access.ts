import type { ComputerAccessView } from "../../shared/ipc";

// Settings → computer use: the Accessibility line. Pure, so tests can call it.

export const ACCESS_UNSUPPORTED = "Bee uses apps for you on Windows and Mac only.";
export const ACCESS_NEEDS_ACCESSIBILITY = "To use apps for you, Bee needs Accessibility: in System Settings → Privacy & Security → Accessibility, turn on Bee.";

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
