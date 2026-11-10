// The screenshot pages render static markup, so they size the pill as the store does in every state: the header's natural
// width, snapped and clamped (core/overlay-size.ts pillWidth), set as the pill's width. Collapsed, the real app then narrows the
// window to it; the body or panel under the pill stays full width.
import { pillWidth } from "../../src/core/overlay-size";
import { naturalWidth } from "../../src/renderer/src/pill-measure";

export type CompactPill = { natural: number; pill: number; island: number; truncated: boolean };

/** Sizes the page's pill, if any, and returns the measured widths in CSS px. */
export async function compactPill(): Promise<CompactPill | null> {
  await document.fonts.ready;
  const island = document.querySelector<HTMLElement>(".island");
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

/** The width in CSS px of the island body or the panel under the pill, if one is open: both are full width. */
export function bodyWidth(): number | null {
  return document.querySelector(".island-body, .panel")?.getBoundingClientRect().width ?? null;
}
