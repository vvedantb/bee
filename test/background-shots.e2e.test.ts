import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runHarness } from "./e2e/run";

// Electron screenshots of the Live tab background tasks (test/e2e/background-shots.ts, real styles.css).
// No Gateway key needed. Set BEE_E2E_SHOTS_DIR to choose where the PNGs go (default: a temp folder).

const dir = process.env.BEE_E2E_SHOTS_DIR || mkdtempSync(join(tmpdir(), "bee-background-shots-"));
const PNG_MAGIC = "89504e470d0a1a0a";

describe("Background tasks screenshots (Electron E2E)", () => {
  it("writes the Live tab background tasks, on and master-off, as PNGs", async () => {
    const report = await runHarness({
      page: "background-shots",
      env: { BEE_E2E_SHOTS_DIR: dir, BEE_E2E_SHOTS: "settings-live-background" },
      report: z.object({ ok: z.literal(true), files: z.array(z.string()) }),
    });
    expect(report.files.map((file) => file.split("/").pop())).toEqual(["settings-live-background.png"]);
    for (const file of report.files) expect(readFileSync(file).subarray(0, 8).toString("hex")).toBe(PNG_MAGIC);
  });
});
