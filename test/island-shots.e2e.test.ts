import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { HINT_TEXT, type HintId } from "../src/renderer/src/hints";
import { runHarness } from "./e2e/run";

// Electron screenshots of static island states (test/e2e/island-shots.ts, real styles.css) via capturePage().
// No Gateway key needed. Set BEE_SHOTS_DIR (or BEE_E2E_SHOTS_DIR) to choose where the PNGs go (default: a temp folder).

const dir = process.env.BEE_SHOTS_DIR || process.env.BEE_E2E_SHOTS_DIR || mkdtempSync(join(tmpdir(), "bee-island-shots-"));
const PNG_MAGIC = "89504e470d0a1a0a";
const SHOTS = [
  "collapsed",
  "thinking",
  "expanded",
  "meeting-card",
  "briefing-card",
  "follow-up-card",
  "recap-card",
  "long-tip-top",
  "long-tip-scrolled",
  "update-available",
  "response-folded",
  "response-full-text",
  "fresh-utterance",
  "hint-quiet",
  "hint-no-input",
  "hint-clipping",
  "hint-noisy",
  "ask",
  "long-url",
];
const HINTS: HintId[] = ["quiet", "no-input", "clipping", "noisy"];

const box = z.object({ width: z.number(), height: z.number(), centerY: z.number() });
const page = z.object({
  shot: z.string(),
  notch: z.object({ logo: box, buttons: z.array(box) }),
  scroll: z.object({ scrollTop: z.number(), scrollHeight: z.number(), clientHeight: z.number(), scrollWidth: z.number(), clientWidth: z.number() }).optional(),
  clicked: z.string().nullable(),
  open: z.boolean(),
  tips: z.number(),
  hint: z.string().nullable(),
  error: z.boolean(),
});

describe("island screenshots (Electron E2E)", () => {
  it("writes each island state as a PNG, with the logo as big as the notch buttons and long tips scrolling", async () => {
    const report = await runHarness({
      page: "island-shots",
      env: { BEE_E2E_SHOTS_DIR: dir, BEE_E2E_SHOTS: SHOTS.join(",") },
      report: z.object({ ok: z.literal(true), files: z.array(z.string()), pages: z.array(page) }),
    });
    expect(report.files.map((file) => file.split("/").pop())).toEqual(SHOTS.map((shot) => `island-${shot}.png`));
    for (const file of report.files) expect(readFileSync(file).subarray(0, 8).toString("hex")).toBe(PNG_MAGIC);

    for (const { notch } of report.pages) {
      expect(notch.buttons.length).toBeGreaterThanOrEqual(2);
      for (const button of notch.buttons.slice(-2)) {
        expect(notch.logo.height).toBe(button.height);
        expect(Math.abs(notch.logo.centerY - button.centerY)).toBeLessThanOrEqual(0.5);
      }
    }

    const pageFor = (shot: string) => report.pages.find((item) => item.shot === shot);

    // The folded answer is one line with no body; clicking it opens the full text in the island, never the panel.
    expect(pageFor("response-folded")).toMatchObject({ open: false, clicked: null });
    expect(pageFor("response-full-text")).toMatchObject({ open: true, clicked: "full-text", tips: 1 });
    // A fresh question after the last answer settled shows only the new answer.
    expect(pageFor("fresh-utterance")).toMatchObject({ open: true, tips: 1 });

    // Each mic hint opens the body alone, as one calm line: no tips, nothing styled as an error. Other shots show no hint.
    for (const id of HINTS) expect(pageFor(`hint-${id}`)).toMatchObject({ open: true, tips: 0, hint: HINT_TEXT[id], error: false });
    for (const shot of SHOTS.filter((name) => !name.startsWith("hint-"))) expect(pageFor(shot)?.hint).toBeNull();

    // A long unbroken address wraps: no island is ever wider than its scroll area.
    for (const { shot, scroll: area } of report.pages) if (area) expect(area.scrollWidth, shot).toBeLessThanOrEqual(area.clientWidth);
    expect(pageFor("long-url")).toMatchObject({ open: true, tips: 2 });

    // The update button sits before the mic and collapse buttons.
    expect(pageFor("update-available")?.notch.buttons).toHaveLength(3);

    const scroll = (shot: string) => z.object({ scrollTop: z.number(), scrollHeight: z.number(), clientHeight: z.number() }).parse(report.pages.find((item) => item.shot === shot)?.scroll);
    // A long answer opens at its first line and stays there: the body never jumps to the end.
    const top = scroll("long-tip-top");
    expect(top.scrollHeight).toBeGreaterThan(top.clientHeight);
    expect(top.scrollTop).toBeLessThanOrEqual(1);
    // The user's own scroll stays where they leave it.
    const scrolled = scroll("long-tip-scrolled");
    expect(scrolled.scrollTop).toBeGreaterThan(0);
    expect(scrolled.scrollTop).toBeLessThan(scrolled.scrollHeight - scrolled.clientHeight - 24);
  });
});
