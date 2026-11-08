import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runHarness } from "./e2e/run";

// Electron screenshots of the Settings tab's Browser status (test/e2e/browse-settings-shots.ts, real styles.css). No Gateway key
// needed. Set BEE_E2E_SHOTS_DIR to choose where the PNGs go (default: a temp folder).

const dir = process.env.BEE_E2E_SHOTS_DIR || mkdtempSync(join(tmpdir(), "bee-browse-settings-shots-"));
const PNG_MAGIC = "89504e470d0a1a0a";
const SHOTS = ["settings-browse-missing", "settings-browse-installing", "settings-browse-install-failed", "settings-browse-installed", "settings-browse-connected"];

describe("Browser settings screenshots (Electron E2E)", () => {
  it("writes each Browse state as a PNG", async () => {
    const report = await runHarness({
      page: "browse-settings-shots",
      env: { BEE_E2E_SHOTS_DIR: dir, BEE_E2E_SHOTS: SHOTS.join(",") },
      report: z.object({ ok: z.literal(true), files: z.array(z.string()) }),
    });
    expect(report.files.map((file) => file.split("/").pop())).toEqual(SHOTS.map((name) => `${name}.png`));
    for (const file of report.files) expect(readFileSync(file).subarray(0, 8).toString("hex")).toBe(PNG_MAGIC);
  });
});
