import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PILL_MAX } from "../src/core/overlay-size";
import { runHarness } from "./e2e/run";

// Electron screenshots of the Settings tab (test/e2e/settings-shots.ts, real components and styles.css): the names section
// closed and open, and an info tooltip, under the compact pill. Set BEE_E2E_SHOTS_DIR to choose where the PNGs go (default: a temp folder).

const dir = process.env.BEE_E2E_SHOTS_DIR || mkdtempSync(join(tmpdir(), "bee-settings-shots-"));
const PNG_MAGIC = "89504e470d0a1a0a";
const SHOTS = ["settings-overview", "settings-names-open", "settings-tooltip"];

describe("Settings screenshots (Electron E2E)", () => {
  it("writes the Settings tab with the names section closed and open, and a tooltip, as PNGs", async () => {
    const report = await runHarness({
      page: "settings-shots",
      env: { BEE_E2E_SHOTS_DIR: dir, BEE_E2E_SHOTS: SHOTS.join(",") },
      report: z.object({
        ok: z.literal(true),
        files: z.array(z.string()),
        pages: z.array(z.object({ shot: z.string(), compact: z.object({ pill: z.number(), island: z.number() }), panel: z.number() })),
      }),
    });
    expect(report.files.map((file) => file.split("/").pop())).toEqual(SHOTS.map((shot) => `${shot}.png`));
    for (const file of report.files) expect(readFileSync(file).subarray(0, 8).toString("hex")).toBe(PNG_MAGIC);
    // The panel open: the pill over it stays compact, and only the panel is full width.
    console.log(`pill and panel widths: ${JSON.stringify(report.pages)}`);
    for (const { shot, compact, panel } of report.pages) {
      expect(compact.island, shot).toBe(compact.pill);
      expect(compact.pill, shot).toBeLessThan(PILL_MAX);
      expect(panel, shot).toBe(PILL_MAX);
    }
  });
});
