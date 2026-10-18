import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runHarness } from "./e2e/run";

// Electron screenshots of four static island states (test/e2e/island-shots.ts, real styles.css) via capturePage().
// No Gateway key needed. Set BEE_E2E_SHOTS_DIR to choose where the PNGs go (default: a temp folder).

const dir = process.env.BEE_E2E_SHOTS_DIR || mkdtempSync(join(tmpdir(), "bee-island-shots-"));
const PNG_MAGIC = "89504e470d0a1a0a";

describe("island screenshots (Electron E2E)", () => {
  it("writes the collapsed, thinking, expanded and meeting-card states as PNGs", async () => {
    const report = await runHarness({
      page: "island-shots",
      env: { BEE_E2E_SHOTS_DIR: dir, BEE_E2E_SHOTS: "collapsed,thinking,expanded,meeting-card" },
      report: z.object({ ok: z.literal(true), files: z.array(z.string()) }),
    });
    expect(report.files.map((file) => file.split("/").pop())).toEqual(["island-collapsed.png", "island-thinking.png", "island-expanded.png", "island-meeting-card.png"]);
    for (const file of report.files) expect(readFileSync(file).subarray(0, 8).toString("hex")).toBe(PNG_MAGIC);
  });
});
