import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runHarness } from "./e2e/run";

// Electron screenshots of the Settings tab's Meeting context section (test/e2e/meeting-settings-shots.ts, real styles.css).
// No Gateway key needed. Set BEE_E2E_SHOTS_DIR to choose where the PNGs go (default: a temp folder).

const dir = process.env.BEE_E2E_SHOTS_DIR || mkdtempSync(join(tmpdir(), "bee-meeting-settings-shots-"));
const PNG_MAGIC = "89504e470d0a1a0a";

describe("meeting settings screenshots (Electron E2E)", () => {
  it("writes the Meeting context section, on and master-off, as PNGs", async () => {
    const report = await runHarness({
      page: "meeting-settings-shots",
      env: { BEE_E2E_SHOTS_DIR: dir, BEE_E2E_SHOTS: "settings-meeting-context,settings-meeting-context-off" },
      report: z.object({ ok: z.literal(true), files: z.array(z.string()) }),
    });
    expect(report.files.map((file) => file.split("/").pop())).toEqual(["settings-meeting-context.png", "settings-meeting-context-off.png"]);
    for (const file of report.files) expect(readFileSync(file).subarray(0, 8).toString("hex")).toBe(PNG_MAGIC);
  });
});
