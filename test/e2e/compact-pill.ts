// The screenshot pages render static markup, so they size a collapsed island as the store does: the header's natural width,
// snapped and clamped (core/overlay-size.ts pillWidth), set as the island's width. The real app then narrows the window to it.
import { pillWidth } from "../../src/core/overlay-size";
import { naturalWidth } from "../../src/renderer/src/pill-measure";

export type CompactPill = { natural: number; pill: number; island: number; truncated: boolean };

/** Sizes the page's collapsed island, if any, and returns the measured widths in CSS px. Open islands stay full width. */
export async function compactPill(): Promise<CompactPill | null> {
  await document.fonts.ready;
  const island = document.querySelector<HTMLElement>(".island:not(.open)");
  const header = island?.querySelector<HTMLElement>(".notch");
  if (!island || !header) return null;
  const natural = naturalWidth(header);
  const pill = pillWidth(natural);
  island.style.width = `${pill}px`;
  // Two frames, so the harness's capture right after the report shows the new width.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  // The status ends in "…" when its text is wider than what is shown.
  const text = header.querySelector(".notch-status-text");
  const truncated = text ? text.scrollWidth > text.clientWidth : false;
  return { natural: Math.round(natural * 10) / 10, pill, island: island.getBoundingClientRect().width, truncated };
}

/** The open island's width in CSS px, for shots that show full width. */
export function islandWidth(): number | null {
  return document.querySelector(".island")?.getBoundingClientRect().width ?? null;
}
