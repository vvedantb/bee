import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runHarness } from "./e2e/run";

// Electron screenshots of the meeting flow in Bee's pill (test/e2e/meeting-shots.ts): the short notices in place of the status,
// the Start / Stop meeting buttons (auto-confirm off), and "Meeting in progress". No Gateway key needed. Set BEE_E2E_SHOTS_DIR to
// choose where the PNGs go.

const dir = process.env.BEE_E2E_SHOTS_DIR || mkdtempSync(join(tmpdir(), "bee-meeting-shots-"));
const PNG_MAGIC = "89504e470d0a1a0a";
const SHOTS = [
  "meeting-notice-start",
  "meeting-notice-end",
  "meeting-notice-prejoin-ready",
  "meeting-bar-start",
  "meeting-bar-stop",
  "meeting-bar-stop-no-mic",
  "meeting-notch-in-progress",
];
const page = z.object({ shot: z.string(), notch: z.string().nullable(), button: z.string().nullable(), fits: z.boolean(), truncated: z.boolean() });

describe("meeting pill screenshots (Electron E2E)", () => {
  it("renders the notices, the Start meeting and Stop meeting buttons and the notch line inside the pill, and writes each as a PNG", async () => {
    const report = await runHarness({
      page: "meeting-shots",
      env: { BEE_E2E_SHOTS_DIR: dir, BEE_E2E_SHOTS: SHOTS.join(",") },
      report: z.object({ ok: z.literal(true), files: z.array(z.string()), pages: z.array(page) }),
    });
    expect(report.files.map((file) => file.split("/").pop())).toEqual(SHOTS.map((shot) => `${shot}.png`));
    for (const file of report.files) expect(readFileSync(file).subarray(0, 8).toString("hex")).toBe(PNG_MAGIC);
    const byShot = Object.fromEntries(report.pages.map((entry) => [entry.shot, entry]));
    // Auto-confirm on: the notices replace the status for a few seconds, with no button.
    expect(byShot["meeting-notice-start"]).toMatchObject({ notch: "Meeting in progress, Bee is active", button: null });
    expect(byShot["meeting-notice-end"]).toMatchObject({ notch: "Meeting ended, notes have been saved", button: null });
    expect(byShot["meeting-notice-prejoin-ready"]).toMatchObject({ notch: "Meeting starting, Bee is getting ready", button: null });
    // Auto-confirm off: a detected call is not yet in progress; after Start it is, with Stop meeting.
    expect(byShot["meeting-bar-start"]).toMatchObject({ notch: "Meeting detected", button: "Start meeting" });
    expect(byShot["meeting-bar-stop"]).toMatchObject({ notch: "Meeting in progress", button: "Stop meeting" });
    // Every notice fits beside the button; a longer one would truncate instead of pushing the controls out of the pill.
    expect(byShot["meeting-bar-stop-no-mic"]).toMatchObject({ notch: "Microphone unavailable", button: "Stop meeting", truncated: false });
    expect(byShot["meeting-notch-in-progress"]).toMatchObject({ notch: "Meeting in progress", button: null });
    for (const shot of SHOTS) expect(byShot[shot]?.fits).toBe(true);
  });
});
