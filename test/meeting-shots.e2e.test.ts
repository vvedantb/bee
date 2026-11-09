import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runHarness } from "./e2e/run";

// Electron screenshots of the meeting flow (test/e2e/meeting-shots.ts): the real toaster showing the start and end toasts, the Start /
// Stop meeting button toasts (auto-confirm off), and the notch saying "Meeting in progress". No Gateway key needed. Set BEE_E2E_SHOTS_DIR to choose where the PNGs go.

const dir = process.env.BEE_E2E_SHOTS_DIR || mkdtempSync(join(tmpdir(), "bee-meeting-shots-"));
const PNG_MAGIC = "89504e470d0a1a0a";
const SHOTS = ["meeting-toast-start", "meeting-toast-end", "meeting-toast-start-prompt", "meeting-toast-stop-prompt", "meeting-notch-in-progress"];
const page = z.object({ shot: z.string(), notch: z.string().nullable(), toast: z.string().nullable(), button: z.string().nullable() });

describe("quiet meeting screenshots (Electron E2E)", () => {
  it("renders the start, end, Start meeting and Stop meeting toasts and the notch line, and writes each as a PNG", async () => {
    const report = await runHarness({
      page: "meeting-shots",
      env: { BEE_E2E_SHOTS_DIR: dir, BEE_E2E_SHOTS: SHOTS.join(",") },
      report: z.object({ ok: z.literal(true), files: z.array(z.string()), pages: z.array(page) }),
    });
    expect(report.files.map((file) => file.split("/").pop())).toEqual(SHOTS.map((shot) => `${shot}.png`));
    for (const file of report.files) expect(readFileSync(file).subarray(0, 8).toString("hex")).toBe(PNG_MAGIC);
    const byShot = Object.fromEntries(report.pages.map((entry) => [entry.shot, entry]));
    expect(byShot["meeting-toast-start"]?.toast).toBe("Meeting in progress, Bee is active");
    expect(byShot["meeting-toast-start"]?.notch).toBe("Meeting in progress");
    expect(byShot["meeting-toast-end"]?.toast).toBe("Meeting ended, notes have been saved");
    // Auto-confirm on: no buttons. Off: the real Start / Stop meeting labels.
    expect(byShot["meeting-toast-start"]?.button).toBeNull();
    expect(byShot["meeting-toast-end"]?.button).toBeNull();
    expect(byShot["meeting-toast-start-prompt"]?.toast).toBe("Meeting detected");
    expect(byShot["meeting-toast-start-prompt"]?.button).toBe("Start meeting");
    expect(byShot["meeting-toast-stop-prompt"]?.toast).toBe("Meeting in progress");
    expect(byShot["meeting-toast-stop-prompt"]?.button).toBe("Stop meeting");
    expect(byShot["meeting-notch-in-progress"]?.notch).toBe("Meeting in progress");
    expect(byShot["meeting-notch-in-progress"]?.toast).toBeNull();
  });
});
