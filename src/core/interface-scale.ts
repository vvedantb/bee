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

type Rect = { x: number; y: number; width: number; height: number };

/**
 * Bounds for a window of `size` centred at the top of `area`, `margin` below its top edge, and never larger than the area.
 * A window that was cut down scrolls its content, so at 150% and 175% it still fits a 900 px high screen.
 */
export function fitToWorkArea(size: { width: number; height: number }, area: Rect, margin: number): Rect {
  const width = Math.min(size.width, area.width);
  const height = Math.min(size.height, area.height - margin);
  return { x: Math.round(area.x + (area.width - width) / 2), y: area.y + margin, width, height };
}
