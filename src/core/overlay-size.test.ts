import { describe, expect, it } from "vitest";
import { scaleSize, type Rect } from "./interface-scale";
import { OVERLAY_SIZES, PILL_MAX, PILL_MIN, SHELL_PADDING, clampPill, fullWidthX, overlaySize, pillWidth, resizeAboutCentre } from "./overlay-size";

describe("pillWidth", () => {
  it("rounds the natural width up to an 8 px step", () => {
    expect(pillWidth(289)).toBe(296);
    expect(pillWidth(296)).toBe(296);
    expect(pillWidth(296.4)).toBe(304);
  });

  it("keeps a tiny header at the minimum and a wide one at full width", () => {
    expect(pillWidth(0)).toBe(PILL_MIN);
    expect(pillWidth(120)).toBe(PILL_MIN);
    expect(pillWidth(900)).toBe(PILL_MAX);
  });

  it("is full width less the shell margin", () => {
    expect(PILL_MAX).toBe(OVERLAY_SIZES.collapsed.width - 2 * SHELL_PADDING);
  });
});

describe("clampPill", () => {
  it("clamps any renderer number into range", () => {
    expect(clampPill(10)).toBe(PILL_MIN);
    expect(clampPill(5000)).toBe(PILL_MAX);
    expect(clampPill(320)).toBe(320);
  });
});

describe("overlaySize", () => {
  it("is the pill plus the shell margin when collapsed", () => {
    expect(overlaySize("collapsed", 296)).toEqual({ width: 304, height: 64 });
    expect(overlaySize("collapsed", PILL_MAX)).toEqual(OVERLAY_SIZES.collapsed);
    expect(overlaySize("collapsed", 9999)).toEqual(OVERLAY_SIZES.collapsed);
  });

  it("ignores the pill when a response or the panel is open", () => {
    expect(overlaySize("response", 296)).toEqual({ width: 480, height: 360 });
    expect(overlaySize("expanded", 296)).toEqual({ width: 480, height: 640 });
  });
});

describe("resizeAboutCentre", () => {
  const area: Rect = { x: 0, y: 0, width: 1920, height: 1080 };
  const centre = (rect: Rect) => rect.x + rect.width / 2;

  it("grows and shrinks about the same centre, with no drift over many cycles", () => {
    for (const scale of [1, 1.1, 1.25, 1.75]) {
      const narrow = scaleSize(overlaySize("collapsed", 296), scale);
      const wide = scaleSize(overlaySize("response", 296), scale);
      const start: Rect = { x: 800, y: 8, ...narrow };
      let bounds = start;
      for (let cycle = 0; cycle < 5; cycle++) {
        bounds = resizeAboutCentre({ size: wide, current: bounds, area, margin: 8 });
        expect(bounds.width).toBe(wide.width);
        expect(Math.abs(centre(bounds) - centre(start))).toBeLessThanOrEqual(0.5);
        bounds = resizeAboutCentre({ size: narrow, current: bounds, area, margin: 8 });
      }
      expect(bounds).toEqual(start);
    }
  });

  it("shifts only to stay inside the work area", () => {
    const bounds = resizeAboutCentre({ size: { width: 480, height: 360 }, current: { x: 1700, y: 8, width: 304, height: 64 }, area, margin: 8 });
    expect(bounds).toEqual({ x: 1440, y: 8, width: 480, height: 360 });
  });
});

describe("fullWidthX", () => {
  it("is the full-width window's x with the same centre", () => {
    expect(fullWidthX({ x: 808, y: 8, width: 304, height: 64 }, 480)).toBe(720);
    expect(fullWidthX({ x: 720, y: 8, width: 480, height: 64 }, 480)).toBe(720);
  });
});
