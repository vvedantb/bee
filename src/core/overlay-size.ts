// The overlay window's size per mode, and the compact pill: collapsed, the window hugs the pill's content like a Dynamic
// Island; with a response or the panel open it is the full width. All widths here are CSS px at 100% (main scales them).
import { placeInWorkArea, type Rect, type Size } from "./interface-scale";

export const WINDOW_SIZES = ["collapsed", "response", "expanded"] as const;
export type WindowMode = (typeof WINDOW_SIZES)[number];

// One full width in every open state, so expanding only grows the height and the pill row never moves sideways.
export const OVERLAY_SIZES: Record<WindowMode, Size> = {
  collapsed: { width: 480, height: 64 },
  // Notch plus the island body (tips and sources).
  response: { width: 480, height: 360 },
  expanded: { width: 480, height: 640 },
};

// .shell padding in styles.css: the clear margin round the island on each side.
export const SHELL_PADDING = 4;
// The island at full width, and the narrowest compact pill (logo, a short status, mic and chevron fit).
export const PILL_MAX = OVERLAY_SIZES.collapsed.width - 2 * SHELL_PADDING;
export const PILL_MIN = 264;
// Widths snap to this step, so a status that changes by a few pixels does not resize the window.
const PILL_STEP = 8;

/** The pill width for the header's natural width: rounded up to the step, then kept within [PILL_MIN, PILL_MAX]. */
export function pillWidth(natural: number): number {
  return clampPill(Math.ceil(natural / PILL_STEP) * PILL_STEP);
}

/** Any requested width kept within [PILL_MIN, PILL_MAX] (main does not trust the renderer's number). */
export function clampPill(width: number): number {
  return Math.min(PILL_MAX, Math.max(PILL_MIN, width));
}

/** The window size at 100% for a mode: collapsed is the pill plus the shell margin, the others are full width. */
export function overlaySize(mode: WindowMode, pill: number): Size {
  if (mode !== "collapsed") return OVERLAY_SIZES[mode];
  return { width: clampPill(pill) + 2 * SHELL_PADDING, height: OVERLAY_SIZES.collapsed.height };
}

/**
 * Bounds for `size` with the same horizontal centre as `current`, kept inside `area` (placeInWorkArea). Truncating the half
 * difference keeps narrow → wide → narrow drift-free when the difference is odd.
 */
export function resizeAboutCentre(args: { size: Size; current: Rect; area: Rect; margin: number }): Rect {
  const { size, current, area, margin } = args;
  const x = current.x + Math.trunc((current.width - size.width) / 2);
  return placeInWorkArea({ size, current: { x, y: current.y }, area, margin });
}

/** The x a window of `fullWidth` would have with the same centre as `bounds`, so a saved spot restores at full width. */
export function fullWidthX(bounds: Rect, fullWidth: number): number {
  return bounds.x + Math.trunc((bounds.width - fullWidth) / 2);
}
