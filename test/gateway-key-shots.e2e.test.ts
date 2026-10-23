import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runHarness } from "./e2e/run";

// Electron screenshots of the Settings tab's saved AI Gateway API key (test/e2e/gateway-key-shots.ts, real styles.css).
// Uses a fake key from harness-main.ts; no Gateway key needed. Set BEE_E2E_SHOTS_DIR to choose where the PNGs go (default: a temp folder).

const dir = process.env.BEE_E2E_SHOTS_DIR || mkdtempSync(join(tmpdir(), "bee-gateway-key-shots-"));
const PNG_MAGIC = "89504e470d0a1a0a";

describe("gateway key screenshots (Electron E2E)", () => {
  it("writes the masked, revealed and copied states as PNGs", async () => {
    const report = await runHarness({
      page: "gateway-key-shots",
      env: { BEE_E2E_SHOTS_DIR: dir, BEE_E2E_SHOTS: "gateway-key-masked,gateway-key-revealed,gateway-key-copied" },
      report: z.object({ ok: z.literal(true), files: z.array(z.string()) }),
    });
    expect(report.files.map((file) => file.split("/").pop())).toEqual(["gateway-key-masked.png", "gateway-key-revealed.png", "gateway-key-copied.png"]);
    for (const file of report.files) expect(readFileSync(file).subarray(0, 8).toString("hex")).toBe(PNG_MAGIC);
  });
});
