// Interface size: main sets the webContents zoom and scales the window bounds by the same factor.
export const INTERFACE_SCALES = [0.9, 1, 1.1, 1.25, 1.5, 1.75] as const;
export type InterfaceScale = (typeof INTERFACE_SCALES)[number];
export const DEFAULT_INTERFACE_SCALE: InterfaceScale = 1;

/** An allowed factor as is; anything else (missing, NaN, a string, an unlisted number) is 100%. */
export function clampInterfaceScale(value: unknown): InterfaceScale {
  return INTERFACE_SCALES.find((scale) => scale === value) ?? DEFAULT_INTERFACE_SCALE;
}

/** Window size in DIPs at a zoom factor, rounded to whole pixels. */
export function scaleSize(size: { width: number; height: number }, factor: number): { width: number; height: number } {
  return { width: Math.round(size.width * factor), height: Math.round(size.height * factor) };
}

export type Rect = { x: number; y: number; width: number; height: number };

/**
 * Bounds for a window of `size` centred at the top of `area`, `margin` below its top edge, and never larger than the area.
 * A window that was cut down scrolls its content, so at 150% and 175% it still fits a 900 px high screen.
 */
export function fitToWorkArea(size: { width: number; height: number }, area: Rect, margin: number): Rect {
  const width = Math.min(size.width, area.width);
  const height = Math.min(size.height, area.height - margin);
  return { x: Math.round(area.x + (area.width - width) / 2), y: area.y + margin, width, height };
}

export type Size = { width: number; height: number };
/** Electron display fields that placement needs. All rects are DIPs, so `scaleFactor` is never applied here. */
export type DisplayInfo = { id: number; bounds: Rect; workArea: Rect; scaleFactor: number };
export type SavedPosition = { x: number; y: number; displayId: number };

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** The display with the largest overlap with `bounds`; with no overlap, the one whose centre is nearest. Undefined for an empty list. */
export function displayMatching(bounds: Rect, displays: readonly DisplayInfo[]): DisplayInfo | undefined {
  let best: DisplayInfo | undefined;
  let bestOverlap = 0;
  for (const display of displays) {
    const overlap = overlapArea(bounds, display.bounds);
    if (overlap > bestOverlap) {
      best = display;
      bestOverlap = overlap;
    }
  }
  if (best) return best;
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  let nearest = Infinity;
  for (const display of displays) {
    const distance = Math.hypot(display.bounds.x + display.bounds.width / 2 - cx, display.bounds.y + display.bounds.height / 2 - cy);
    if (distance < nearest) {
      best = display;
      nearest = distance;
    }
  }
  return best;
}

/**
 * Bounds of `size` that keep `current.x` and `current.y`, shrunk to fit `area` and shifted only as far as needed to stay inside it.
 * The top never rises above `area.y + margin`.
 */
export function placeInWorkArea(args: { size: Size; current: { x: number; y: number }; area: Rect; margin: number }): Rect {
  const { size, current, area, margin } = args;
  const width = Math.min(size.width, area.width);
  const height = Math.min(size.height, area.height - margin);
  const x = Math.max(area.x, Math.min(current.x, area.x + area.width - width));
  const y = Math.max(area.y + margin, Math.min(current.y, area.y + area.height - height));
  return { x, y, width, height };
}

/** Start-up bounds: the saved spot on its display, or the primary display's top centre when there is none or that display is gone. */
export function restoreOverlayBounds(args: {
  saved: SavedPosition | undefined;
  size: Size;
  displays: readonly DisplayInfo[];
  primaryId: number;
  margin: number;
}): Rect {
  const { saved, size, displays, primaryId, margin } = args;
  const savedDisplay = saved ? displays.find((display) => display.id === saved.displayId) : undefined;
  if (saved && savedDisplay) return placeInWorkArea({ size, current: saved, area: savedDisplay.workArea, margin });
  const primary = displays.find((display) => display.id === primaryId) ?? displays[0];
  if (!primary) return { x: 0, y: margin, ...size };
  return fitToWorkArea(size, primary.workArea, margin);
}
