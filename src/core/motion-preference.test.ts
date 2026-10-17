import { describe, expect, it } from "vitest";
import { MOTION_PREFERENCES, clampMotionPreference, resolveReducedMotion } from "./motion-preference";

describe("clampMotionPreference", () => {
  it("keeps every allowed value", () => {
    for (const preference of MOTION_PREFERENCES) expect(clampMotionPreference(preference)).toBe(preference);
  });

  it("reads anything else as on", () => {
    for (const bad of [undefined, null, 1, true, "", "ON", "reduce", {}, ["off"]]) expect(clampMotionPreference(bad)).toBe("on");
  });
});

describe("resolveReducedMotion", () => {
  it("follows the OS for system", () => {
    expect(resolveReducedMotion("system", true)).toBe(true);
    expect(resolveReducedMotion("system", false)).toBe(false);
  });

  it("never reduces for on", () => {
    expect(resolveReducedMotion("on", true)).toBe(false);
    expect(resolveReducedMotion("on", false)).toBe(false);
  });

  it("always reduces for off", () => {
    expect(resolveReducedMotion("off", true)).toBe(true);
    expect(resolveReducedMotion("off", false)).toBe(true);
  });
});
