import { describe, expect, it } from "vitest";
import { INTERFACE_SCALES, clampInterfaceScale, fitToWorkArea, scaleSize } from "./interface-scale";

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
    expect(scaleSize({ width: 440, height: 64 }, 1.25)).toEqual({ width: 550, height: 80 });
  });

  it("rounds to whole pixels", () => {
    expect(scaleSize({ width: 440, height: 330 }, 0.9)).toEqual({ width: 396, height: 297 });
    expect(scaleSize({ width: 440, height: 64 }, 1.1)).toEqual({ width: 484, height: 70 });
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
