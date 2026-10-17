import { describe, expect, it } from "vitest";
import { INTERFACE_SCALES, clampInterfaceScale, scaleSize } from "./interface-scale";

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
