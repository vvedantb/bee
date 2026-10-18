import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { runHarness } from "./e2e/run";

// Electron screenshots of the Live tab with Teams sync chip + Notes ranking label.
// No Gateway key needed. Set BEE_E2E_SHOTS_DIR to choose where the PNGs go.
const dir = process.env.BEE_E2E_SHOTS_DIR || mkdtempSync(join(tmpdir(), "bee-live-tab-shots-"));

it("writes the Live tab sync+notes state as a PNG", async () => {
  const report = await runHarness({
    page: "live-tab-shots",
    env: { BEE_E2E_SHOTS_DIR: dir, BEE_E2E_SHOTS: "live-sync-notes" },
    report: z.object({ ok: z.literal(true), files: z.array(z.string()) }),
  });
  expect(report.ok).toBe(true);
  expect(report.files.some((f) => f.endsWith("live-sync-notes.png"))).toBe(true);
});
