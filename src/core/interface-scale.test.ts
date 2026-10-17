import { describe, expect, it } from "vitest";
import { INTERFACE_SCALES, clampInterfaceScale, displayMatching, fitToWorkArea, placeInWorkArea, restoreOverlayBounds, scaleSize, type DisplayInfo } from "./interface-scale";

describe("clampInterfaceScale", () => {
  it("keeps every allowed factor", () => {
    for (const scale of INTERFACE_SCALES) expect(clampInterfaceScale(scale)).toBe(scale);
  });

  it("falls back to 100% for anything else", () => {
    for (const bad of [undefined, null, NaN, Infinity, 0, -1, 1.3, 2, "1.5", {}]) expect(clampInterfaceScale(bad)).toBe(1);
  });
});

describe("scaleSize", () => {
  const expanded = { width: 480, height: 640 };

  it("is the identity at 100%", () => {
    expect(scaleSize(expanded, 1)).toEqual(expanded);
  });

  it("multiplies width and height by the factor", () => {
    expect(scaleSize(expanded, 1.5)).toEqual({ width: 720, height: 960 });
    expect(scaleSize({ width: 480, height: 64 }, 1.25)).toEqual({ width: 600, height: 80 });
  });

  it("rounds to whole pixels", () => {
    expect(scaleSize({ width: 480, height: 330 }, 0.9)).toEqual({ width: 432, height: 297 });
    expect(scaleSize({ width: 480, height: 64 }, 1.1)).toEqual({ width: 528, height: 70 });
  });
});

describe("fitToWorkArea", () => {
  const screen900 = { x: 0, y: 25, width: 1440, height: 875 };

  it("does not clamp at 100% on a large display, and centres at the top", () => {
    const area = { x: 0, y: 0, width: 2560, height: 1400 };
    expect(fitToWorkArea({ width: 480, height: 640 }, area, 8)).toEqual({ x: 1040, y: 8, width: 480, height: 640 });
  });

  it("cuts 150% (960 px high) to the work area minus the top margin", () => {
    expect(fitToWorkArea(scaleSize({ width: 480, height: 640 }, 1.5), screen900, 8)).toEqual({ x: 360, y: 33, width: 720, height: 867 });
  });

  it("cuts 175% (1120 px high) the same way, and a width wider than the area", () => {
    const narrow = { x: 100, y: 0, width: 800, height: 900 };
    expect(fitToWorkArea(scaleSize({ width: 480, height: 640 }, 1.75), narrow, 8)).toEqual({ x: 100, y: 8, width: 800, height: 892 });
  });
});

const MARGIN = 8;
const primary: DisplayInfo = {
  id: 1,
  scaleFactor: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 25, width: 1920, height: 1055 },
};
const right: DisplayInfo = {
  id: 2,
  scaleFactor: 1,
  bounds: { x: 1920, y: 0, width: 1280, height: 800 },
  workArea: { x: 1920, y: 0, width: 1280, height: 800 },
};
const left: DisplayInfo = {
  id: 3,
  scaleFactor: 1,
  bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
  workArea: { x: -1920, y: 0, width: 1920, height: 1080 },
};
const collapsed = { width: 480, height: 64 };
const expanded = { width: 480, height: 640 };

describe("displayMatching", () => {
  it("picks the display with the largest overlap", () => {
    expect(displayMatching({ x: 1800, y: 100, width: 480, height: 64 }, [primary, right])?.id).toBe(2);
    expect(displayMatching({ x: 1000, y: 100, width: 480, height: 64 }, [primary, right])?.id).toBe(1);
  });

  it("falls back to the nearest centre when nothing overlaps", () => {
    expect(displayMatching({ x: 5000, y: 0, width: 100, height: 100 }, [primary, right])?.id).toBe(2);
    expect(displayMatching({ x: 0, y: 0, width: 1, height: 1 }, [])).toBeUndefined();
  });
});

describe("placeInWorkArea", () => {
  it("grows in place on a secondary display to the right", () => {
    const current = { x: 2200, y: 40, ...collapsed };
    const next = placeInWorkArea({ size: expanded, current, area: right.workArea, margin: MARGIN });
    expect(next).toEqual({ x: 2200, y: 40, ...expanded });
  });

  it("keeps x and width when expanding from the collapsed size", () => {
    const current = { x: 2200, y: 40, ...collapsed };
    const next = placeInWorkArea({ size: expanded, current, area: right.workArea, margin: MARGIN });
    expect(next.x).toBe(current.x);
    expect(next.width).toBe(collapsed.width);
  });

  it("stays on a display at negative coordinates", () => {
    const next = placeInWorkArea({ size: expanded, current: { x: -1500, y: 20 }, area: left.workArea, margin: MARGIN });
    expect(next.x).toBe(-1500);
    expect(next.x).toBeGreaterThanOrEqual(left.workArea.x);
    expect(next.x + next.width).toBeLessThanOrEqual(left.workArea.x + left.workArea.width);
  });

  it("shifts left from the right edge of a small secondary, inside its work area only", () => {
    const next = placeInWorkArea({ size: expanded, current: { x: 3000, y: 10 }, area: right.workArea, margin: MARGIN });
    expect(next.x + next.width).toBe(right.workArea.x + right.workArea.width);
    expect(next.x).toBe(3200 - 480);
    expect(next.x).toBeGreaterThanOrEqual(right.workArea.x);
  });

  it("keeps the top margin and shrinks a size larger than the area", () => {
    const small = { x: 0, y: 0, width: 300, height: 400 };
    const next = placeInWorkArea({ size: expanded, current: { x: 50, y: 0 }, area: small, margin: MARGIN });
    expect(next).toEqual({ x: 0, y: MARGIN, width: 300, height: 400 - MARGIN });
  });

  it("pulls a window that would overflow the bottom back up", () => {
    const next = placeInWorkArea({ size: expanded, current: { x: 2000, y: 500 }, area: right.workArea, margin: MARGIN });
    expect(next.y).toBe(800 - 640);
  });

  it("uses workArea DIPs whatever the scale factor", () => {
    const retina: DisplayInfo = { ...right, scaleFactor: 2 };
    const plain: DisplayInfo = { ...right, scaleFactor: 1 };
    const current = { x: 3000, y: 10 };
    const a = placeInWorkArea({ size: expanded, current, area: retina.workArea, margin: MARGIN });
    const b = placeInWorkArea({ size: expanded, current, area: plain.workArea, margin: MARGIN });
    expect(a).toEqual(b);
    expect(a.x + a.width).toBeLessThanOrEqual(retina.workArea.x + retina.workArea.width);
  });
});

describe("restoreOverlayBounds", () => {
  const displays = [primary, { ...right, scaleFactor: 2 }];

  it("restores onto the saved display at the saved spot", () => {
    const bounds = restoreOverlayBounds({ saved: { x: 2400, y: 30, displayId: 2 }, size: collapsed, displays, primaryId: 1, margin: MARGIN });
    expect(bounds).toEqual({ x: 2400, y: 30, ...collapsed });
  });

  it("clamps a saved spot into the saved display after a resolution change", () => {
    const bounds = restoreOverlayBounds({ saved: { x: 9000, y: 30, displayId: 2 }, size: collapsed, displays, primaryId: 1, margin: MARGIN });
    expect(bounds.x).toBe(3200 - 480);
  });

  it("falls back to the primary top centre when the saved display is gone", () => {
    const bounds = restoreOverlayBounds({ saved: { x: 2400, y: 30, displayId: 99 }, size: collapsed, displays, primaryId: 1, margin: MARGIN });
    expect(bounds).toEqual(fitToWorkArea(collapsed, primary.workArea, MARGIN));
  });

  it("uses the primary top centre on first run", () => {
    const bounds = restoreOverlayBounds({ saved: undefined, size: collapsed, displays, primaryId: 1, margin: MARGIN });
    expect(bounds).toEqual({ x: 720, y: 33, ...collapsed });
  });
});
