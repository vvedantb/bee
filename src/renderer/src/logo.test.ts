import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BeeLogo } from "./BeeLogo";
import { LOGO_TINY_BELOW, blinkTiming, logoDetail } from "./logo";

describe("logoDetail", () => {
  it("keeps stripes, eyes and wings only below 24 px, in a cropped view", () => {
    for (const size of [16, 20, LOGO_TINY_BELOW - 1]) {
      expect(logoDetail(size)).toEqual({ viewBox: "7 7 50 50", glow: false, antennae: false, catchlights: false, grain: false });
    }
  });

  it("adds glow and antennae from 24 px, catchlights from 32 px and grain from 48 px", () => {
    expect(logoDetail(24)).toMatchObject({ viewBox: "0 0 64 64", glow: true, antennae: true, catchlights: false, grain: false });
    expect(logoDetail(32)).toMatchObject({ catchlights: true, grain: false });
    expect(logoDetail(48)).toMatchObject({ catchlights: true, grain: true });
  });
});

describe("blinkTiming", () => {
  it("blinks every 3–5 s with a phase inside the period, the same for the same seed", () => {
    for (const seed of ["", "r0", "r1", "«r2»", "a-much-longer-seed"]) {
      const { periodS, delayS } = blinkTiming(seed);
      expect(periodS).toBeGreaterThanOrEqual(3);
      expect(periodS).toBeLessThan(5);
      expect(delayS).toBeGreaterThanOrEqual(0);
      expect(delayS).toBeLessThan(periodS);
      expect(blinkTiming(seed)).toEqual({ periodS, delayS });
    }
  });

  it("staggers different instances", () => {
    expect(blinkTiming("r0")).not.toEqual(blinkTiming("r1"));
  });
});

describe("BeeLogo", () => {
  it("is decorative by default and labelled when titled", () => {
    expect(renderToStaticMarkup(createElement(BeeLogo))).toContain('aria-hidden="true"');
    const titled = renderToStaticMarkup(createElement(BeeLogo, { title: "Bee" }));
    expect(titled).toContain('role="img"');
    expect(titled).toContain("<title>Bee</title>");
    expect(titled).not.toContain("aria-hidden");
  });

  it("gives each instance its own gradient ids", () => {
    const markup = renderToStaticMarkup(createElement("div", null, createElement(BeeLogo), createElement(BeeLogo)));
    const ids = [...markup.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("draws grey, outlined wings on a light background and keeps the dark look by default", () => {
    const dark = renderToStaticMarkup(createElement(BeeLogo));
    const light = renderToStaticMarkup(createElement(BeeLogo, { tone: "light" }));
    expect(dark).toBe(renderToStaticMarkup(createElement(BeeLogo, { tone: "dark" })));
    expect(dark).toContain('stroke="#ffffff"');
    expect(light).toContain('stroke="#8a8a92"');
    expect(light).not.toContain('stroke="#ffffff"');
  });

  // The standalone marks, one per background. Update them with `npx vitest run -u`.
  it.each([
    ["dark", "bee-logo.svg"],
    ["light", "bee-logo-light.svg"],
  ] as const)("matches the %s mark in resources/%s", async (tone, file) => {
    const markup = renderToStaticMarkup(createElement(BeeLogo, { size: 512, animated: false, tone }));
    await expect(`${markup}\n`).toMatchFileSnapshot(`../../../resources/${file}`);
  });
});
