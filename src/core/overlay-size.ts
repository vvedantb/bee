// The overlay window's size per mode, and the compact pill: the pill hugs its content like a Dynamic Island in every mode.
// The window is always full width and centred; only its height changes per mode. The pill's compact width is CSS only, and
// the clear window area beside it passes clicks to the app below (ignoresMouse). All sizes here are CSS px at 100% (main
// scales them).
import type { Size } from "./interface-scale";

export const WINDOW_SIZES = ["collapsed", "response", "expanded"] as const;
export type WindowMode = (typeof WINDOW_SIZES)[number];

// One full width in every state, so a mode change only changes the height and the pill row never moves sideways.
export const OVERLAY_SIZES: Record<WindowMode, Size> = {
  collapsed: { width: 480, height: 64 },
  // Notch plus the island body (tips and sources).
  response: { width: 480, height: 360 },
  expanded: { width: 480, height: 640 },
};

// .shell padding in styles.css: the clear margin round the island on each side.
export const SHELL_PADDING = 4;
// Full width inside the shell (the body and panel, and the widest pill), and the narrowest compact pill (logo, a short status, mic and chevron fit).
export const PILL_MAX = OVERLAY_SIZES.collapsed.width - 2 * SHELL_PADDING;
export const PILL_MIN = 264;
// Widths snap to this step, so a status that changes by a few pixels does not move the pill's edges.
const PILL_STEP = 8;

/** The pill width for the header's natural width: rounded up to the step, then kept within [PILL_MIN, PILL_MAX]. */
export function pillWidth(natural: number): number {
  return Math.min(PILL_MAX, Math.max(PILL_MIN, Math.ceil(natural / PILL_STEP) * PILL_STEP));
}

/**
 * Whether the overlay window lets mouse events through to the app below (BrowserWindow.setIgnoreMouseEvents with forward,
 * so the renderer still sees the pointer move). Windows and macOS: yes, unless the pointer is over something Bee paints
 * (interactive). Linux cannot forward mouse moves, so Bee could never take the mouse back: it never lets clicks through.
 */
export function ignoresMouse(platform: NodeJS.Platform, interactive: boolean): boolean {
  return platform !== "linux" && !interactive;
}
