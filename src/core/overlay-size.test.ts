import { describe, expect, it } from "vitest";
import { OVERLAY_SIZES, PILL_MAX, PILL_MIN, SHELL_PADDING, WINDOW_SIZES, ignoresMouse, pillWidth } from "./overlay-size";

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

describe("OVERLAY_SIZES", () => {
  it("is one width in every mode, so only the height changes and the window never moves sideways", () => {
    for (const mode of WINDOW_SIZES) expect(OVERLAY_SIZES[mode].width).toBe(480);
  });
});

describe("ignoresMouse", () => {
  it("lets clicks through the clear area on Windows and macOS, and takes them over Bee's surfaces", () => {
    for (const platform of ["win32", "darwin"] as const) {
      expect(ignoresMouse(platform, false)).toBe(true);
      expect(ignoresMouse(platform, true)).toBe(false);
    }
  });

  it("never lets clicks through on Linux, which cannot forward mouse moves", () => {
    expect(ignoresMouse("linux", false)).toBe(false);
    expect(ignoresMouse("linux", true)).toBe(false);
  });
});
