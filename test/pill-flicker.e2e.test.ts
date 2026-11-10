import { describe, expect, it } from "vitest";
import { z } from "zod";
import { OVERLAY_SIZES } from "../src/core/overlay-size";
import { runHarness } from "./e2e/run";

// The chevron opens and closes the panel without the pill moving (test/e2e/pill-flicker.ts, pill-flicker-main.ts): the real
// store and App in an overlay-like window, captured frame after frame through both toggles. The window keeps its x and width,
// and the pill's edges stay on the same pixels in every frame. Also checks the click-through messages for a pointer moved
// clear → pill → clear. No Gateway key needed.

const frame = z.object({ ms: z.number(), x: z.number(), width: z.number(), height: z.number(), left: z.number().nullable(), right: z.number().nullable(), panel: z.boolean() });
const report = z.object({
  ok: z.literal(true),
  ready: z.object({ pill: z.object({ left: z.number(), width: z.number() }) }),
  hover: z.array(z.boolean()),
  frames: z.array(frame),
});

const spread = (values: number[]) => Math.max(...values) - Math.min(...values);

describe("pill flicker (Electron E2E)", () => {
  it("keeps the window's x and width and the pill's edges still while the chevron opens and closes the panel", async () => {
    const { ready, hover, frames } = await runHarness({ page: "pill-flicker", env: {}, report });
    const panelFrames = frames.filter((item) => item.panel).length;
    const lefts = frames.flatMap((item) => (item.left === null ? [] : [item.left]));
    const rights = frames.flatMap((item) => (item.right === null ? [] : [item.right]));
    const jumps = frames.slice(1).map((item, index) => Math.abs((item.left ?? 0) - (frames[index]?.left ?? 0)));
    console.log(
      `pill flicker: ${JSON.stringify({ pill: ready.pill, hover, frames: frames.length, ms: frames.at(-1)?.ms, panelFrames, xs: [...new Set(frames.map((item) => item.x))], widths: [...new Set(frames.map((item) => item.width))], heights: [...new Set(frames.map((item) => item.height))], lefts: [...new Set(lefts)], rights: [...new Set(rights)], maxJump: Math.max(...jumps) })}`,
    );

    // Pointer clear → chevron → clear: the page starts as "not interactive", then one message each way.
    expect(hover).toEqual([false, true, false]);

    // Enough frames to see both toggles, and both did happen: the panel showed, then was gone again.
    expect(frames.length).toBeGreaterThanOrEqual(20);
    expect(panelFrames).toBeGreaterThan(0);
    expect(frames.at(-1)?.panel).toBe(false);
    expect(new Set(frames.map((item) => item.height))).toEqual(new Set([OVERLAY_SIZES.collapsed.height, OVERLAY_SIZES.expanded.height]));

    // Only the height changes: never the window's x or width.
    expect(new Set(frames.map((item) => item.x)).size).toBe(1);
    expect(new Set(frames.map((item) => item.width))).toEqual(new Set([OVERLAY_SIZES.collapsed.width]));

    // The pill is in every frame, centred, and its edges never move by more than anti-aliasing.
    expect(lefts).toHaveLength(frames.length);
    expect(spread(lefts)).toBeLessThanOrEqual(1);
    expect(spread(rights)).toBeLessThanOrEqual(1);
    expect(Math.abs((lefts[0] ?? 0) - ready.pill.left)).toBeLessThanOrEqual(1);
  });
});
