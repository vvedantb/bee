import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runHarness } from "./e2e/run";

// Electron screenshots of static island states (test/e2e/island-shots.ts, real styles.css) via capturePage().
// No Gateway key needed. Set BEE_E2E_SHOTS_DIR to choose where the PNGs go (default: a temp folder).

const dir = process.env.BEE_E2E_SHOTS_DIR || mkdtempSync(join(tmpdir(), "bee-island-shots-"));
const PNG_MAGIC = "89504e470d0a1a0a";
const SHOTS = ["collapsed", "thinking", "expanded", "meeting-card", "long-tip-bottom", "long-tip-scrolled-up"];

const box = z.object({ width: z.number(), height: z.number(), centerY: z.number() });
const page = z.object({
  shot: z.string(),
  notch: z.object({ logo: box, buttons: z.array(box) }),
  scroll: z.object({ scrollTop: z.number(), scrollHeight: z.number(), clientHeight: z.number() }).optional(),
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

    const scroll = (shot: string) => z.object({ scrollTop: z.number(), scrollHeight: z.number(), clientHeight: z.number() }).parse(report.pages.find((item) => item.shot === shot)?.scroll);
    const bottom = scroll("long-tip-bottom");
    expect(bottom.scrollHeight).toBeGreaterThan(bottom.clientHeight);
    expect(bottom.scrollHeight - bottom.clientHeight - bottom.scrollTop).toBeLessThanOrEqual(1);
    const up = scroll("long-tip-scrolled-up");
    expect(up.scrollTop).toBeGreaterThan(0);
    expect(up.scrollTop).toBeLessThan(up.scrollHeight - up.clientHeight - 24);
  });
});
