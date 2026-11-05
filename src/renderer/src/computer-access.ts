import type { ComputerAccessView } from "../../shared/ipc";

// Settings → computer use: the line under "Ask before sending or deleting". Pure, so tests can call it.

export const ACCESS_UNSUPPORTED = "Bee cannot use apps for you on this computer: its desktop helper is missing.";
export const ACCESS_NEEDS_ACCESSIBILITY = "To use apps for you, Bee needs Accessibility: in System Settings → Privacy & Security → Accessibility, turn on Bee.";
export const ACCESS_LINUX_NO_BUS =
  "Bee cannot reach the Linux accessibility bus (AT-SPI), so it can open apps and pages but not click or type in them. Start Bee from your desktop session.";

/**
 * What macOS still has to allow, that Linux has no accessibility bus, or that this OS has no computer use. Null when there is
 * nothing to do, or before the first check. Only Accessibility: computer use reads the accessibility tree and never takes a
 * picture, so Screen Recording plays no part.
 */
export function computerAccessMessage(access: ComputerAccessView | null | undefined): string | null {
  if (!access) return null;
  if (!access.supported) return ACCESS_UNSUPPORTED;
  if (access.accessibility === "denied") return access.platform === "linux" ? ACCESS_LINUX_NO_BUS : ACCESS_NEEDS_ACCESSIBILITY;
  return null;
}
