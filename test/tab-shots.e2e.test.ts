import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PILL_MAX } from "../src/core/overlay-size";
import { PANEL_TABS } from "../src/renderer/src/panel-tabs";
import { runHarness } from "./e2e/run";

// Electron screenshots of the panel tabs (test/e2e/tab-shots.ts, real components and styles.css) under the compact pill: Live
// with the meeting switches (and an info tooltip), Memory with the names closed and open, and Settings. The Connectors tab is in
// mcp-settings-shots. Set BEE_E2E_SHOTS_DIR to choose where the PNGs go (default: a temp folder).

const dir = process.env.BEE_E2E_SHOTS_DIR || mkdtempSync(join(tmpdir(), "bee-tab-shots-"));
const PNG_MAGIC = "89504e470d0a1a0a";
const SHOTS = ["live-meeting", "live-meeting-tooltip", "memory-overview", "memory-names-open", "settings-overview"];

describe("Panel tab screenshots (Electron E2E)", () => {
  it("writes each tab as a PNG, with every tab and the account button on one row, and the names form saves", async () => {
    const report = await runHarness({
      page: "tab-shots",
      env: { BEE_E2E_SHOTS_DIR: dir, BEE_E2E_SHOTS: SHOTS.join(",") },
      report: z.object({
        ok: z.literal(true),
        files: z.array(z.string()),
        pages: z.array(
          z.object({
            shot: z.string(),
            compact: z.object({ pill: z.number(), island: z.number() }),
            panel: z.number(),
            tabs: z.object({ labels: z.array(z.string()), oneRow: z.boolean(), inside: z.boolean() }),
            savedNames: z.array(z.string()).nullable(),
          }),
        ),
      }),
    });
    expect(report.files.map((file) => file.split("/").pop())).toEqual(SHOTS.map((shot) => `${shot}.png`));
    for (const file of report.files) expect(readFileSync(file).subarray(0, 8).toString("hex")).toBe(PNG_MAGIC);
    // Memory → Names Bee should know: its own Save hands over the typed list, one name per line, with no blanks or repeats.
    expect(report.pages.find((page) => page.shot === "memory-names-open")?.savedNames).toEqual([
      "Zuzanna Szczepaniak-Moody",
      "Priya Shah",
      "Krzysztof Nowak",
      "Aoife Byrne",
      "Siobhan Kelly",
      "Sam Lee",
    ]);
    console.log(`pill, panel and tabs: ${JSON.stringify(report.pages)}`);
    for (const { shot, compact, panel, tabs } of report.pages) {
      // The panel open: the pill over it stays compact, and only the panel is full width.
      expect(compact.island, shot).toBe(compact.pill);
      expect(compact.pill, shot).toBeLessThan(PILL_MAX);
      expect(panel, shot).toBe(PILL_MAX);
      // Every tab shows in full beside the account button: no wrap, nothing past the panel's edge.
      expect(tabs.labels, shot).toEqual(PANEL_TABS.map((tab) => tab.label));
      expect(tabs.oneRow, shot).toBe(true);
      expect(tabs.inside, shot).toBe(true);
    }
  });
});
