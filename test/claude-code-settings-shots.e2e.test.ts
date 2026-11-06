import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runHarness } from "./e2e/run";

// Electron screenshots of the Settings tab's Claude Code status (test/e2e/claude-code-settings-shots.ts, real styles.css).
// No Gateway key needed. Set BEE_E2E_SHOTS_DIR to choose where the PNGs go (default: a temp folder).

const dir = process.env.BEE_E2E_SHOTS_DIR || mkdtempSync(join(tmpdir(), "bee-claude-code-settings-shots-"));
const PNG_MAGIC = "89504e470d0a1a0a";

describe("Claude Code settings screenshots (Electron E2E)", () => {
  it("writes the Claude Code status, on and master-off, as PNGs", async () => {
    const report = await runHarness({
      page: "claude-code-settings-shots",
      env: { BEE_E2E_SHOTS_DIR: dir, BEE_E2E_SHOTS: "settings-claude-code-outdated,settings-claude-code-updating,settings-claude-code-update-failed,settings-claude-code-ready" },
      report: z.object({ ok: z.literal(true), files: z.array(z.string()) }),
    });
    expect(report.files.map((file) => file.split("/").pop())).toEqual(["settings-claude-code-outdated.png", "settings-claude-code-updating.png", "settings-claude-code-update-failed.png", "settings-claude-code-ready.png"]);
    for (const file of report.files) expect(readFileSync(file).subarray(0, 8).toString("hex")).toBe(PNG_MAGIC);
  });
});
