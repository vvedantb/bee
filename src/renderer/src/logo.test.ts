import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BeeLogo } from "./BeeLogo";
import { LOGO_TINY_BELOW, blinkTiming, logoDetail, logoMotion, logoMotionCss, type LogoState } from "./logo";

const STATES: LogoState[] = ["idle", "listening", "thinking", "searching", "tool", "done", "error"];
const viewBox = (box: string) => {
  const [x = 0, y = 0, width = 0, height = 0] = box.split(" ").map(Number);
  return { x, y, right: x + width, bottom: y + height };
};

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

describe("logoMotion", () => {
  it("widens the animated tiny view a little and keeps the full view", () => {
    expect(logoMotion(20).viewBox).toBe("5 5 54 54");
    expect(logoMotion(LOGO_TINY_BELOW).viewBox).toBe(logoDetail(LOGO_TINY_BELOW).viewBox);
  });

  // The notch sizes. The ring is centred on the orb (32, 35); its largest size must stay inside the view.
  it.each([16, 20, LOGO_TINY_BELOW - 1])("keeps the listening rings inside the view at %i px", (size) => {
    const motion = logoMotion(size);
    const view = viewBox(motion.viewBox);
    for (const radius of [motion.ringR * (1 + motion.ringGain), motion.ringR * motion.echoScale]) {
      expect(32 - radius).toBeGreaterThanOrEqual(view.x);
      expect(32 + radius).toBeLessThanOrEqual(view.right);
      expect(35 - radius).toBeGreaterThanOrEqual(view.y);
      expect(35 + radius).toBeLessThanOrEqual(view.bottom);
    }
  });
});

describe("logoMotionCss", () => {
  it("defines every generated keyframe, sized by the svg's variables", () => {
    const css = logoMotionCss();
    for (const name of ["bee-eight", "bee-orbit-front", "bee-orbit-back", "bee-loop", "bee-loop-spin", "bee-done-wings"]) expect(css).toContain(`@keyframes ${name}{`);
    for (const variable of ["--eight-x", "--eight-y", "--orbit-x", "--loop-r"]) expect(css).toContain(`var(${variable})`);
    expect(css).not.toContain("NaN");
  });
});

describe("BeeLogo", () => {
  it.each(STATES)("marks the %s state on the svg and draws only that state's extras", (state) => {
    const markup = renderToStaticMarkup(createElement(BeeLogo, { size: 20, state }));
    expect(markup).toContain(`data-state="${state}"`);
    expect(markup).toContain('viewBox="5 5 54 54"');
    expect(markup.includes("bee-fx-ring")).toBe(state === "listening");
    expect(markup.includes("bee-fx-orbit")).toBe(state === "thinking");
    expect(markup.includes("bee-fx-glass")).toBe(state === "searching");
    expect(markup.includes("bee-fx-honey")).toBe(state === "tool");
    expect(markup.includes("bee-fx-spark")).toBe(state === "done");
    expect(markup.includes("#ff8a7a")).toBe(state === "error");
  });

  it("treats busy without a state as thinking, sets the mic level, and stays static when not animated", () => {
    expect(renderToStaticMarkup(createElement(BeeLogo, { busy: true }))).toContain('data-state="thinking"');
    expect(renderToStaticMarkup(createElement(BeeLogo, { state: "listening", level: 0.42 }))).toContain("--level:0.42");
    const still = renderToStaticMarkup(createElement(BeeLogo, { size: 20, animated: false, state: "error" }));
    expect(still).not.toContain("data-state");
    expect(still).toContain('viewBox="7 7 50 50"');
  });

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
