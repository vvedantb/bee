import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { meetingSummaryResultSchema } from "../src/shared/ipc";
import { runHarness } from "./e2e/run";

// Electron E2E of the end-of-meeting summary: preload → main (meeting-ipc.ts) → Luna or the local summary → a markdown
// file in a temp notes folder, which the next pipeline run retrieves. No mic. The Luna case needs BEE_AI_GATEWAY_API_KEY.

const reportSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), notesCited: z.array(z.string()), summary: meetingSummaryResultSchema, recalled: z.array(z.string()) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

async function endMeeting(apiKey: string) {
  const notesDir = join(mkdtempSync(join(tmpdir(), "bee-summary-e2e-")), "notes");
  const report = await runHarness({
    page: "summary-page",
    env: { BEE_E2E_NOTES_DIR: notesDir, BEE_AI_GATEWAY_API_KEY: apiKey },
    report: reportSchema,
  });
  console.log("E2E report:", JSON.stringify(report, null, 2));
  if (!report.ok) throw new Error(`E2E failed: ${report.error}`);
  expect(dirname(report.summary.path)).toBe(notesDir);
  expect(readdirSync(notesDir).filter((name) => /^meeting-\d{4}-/.test(name))).toHaveLength(1);
  const markdown = readFileSync(report.summary.path, "utf8");
  console.log(markdown);
  expect(markdown).toMatch(/^# Meeting summary — \d{4}-\d{2}-\d{2} \d{2}:\d{2}\n/);
  for (const heading of ["## Decisions", "## Action items", "## Topics", "## Notes cited"]) expect(markdown).toContain(heading);
  expect(report.recalled.some((title) => title.startsWith("Meeting summary"))).toBe(true);
  return { report, markdown };
}

describe("end meeting → markdown summary in the notes folder (Electron E2E)", () => {
  it("writes a Luna summary with owners and the notes cited", async () => {
    const apiKey = process.env.BEE_AI_GATEWAY_API_KEY?.trim();
    if (!apiKey) throw new Error("BEE_AI_GATEWAY_API_KEY is not set.");
    const { report, markdown } = await endMeeting(apiKey);
    expect(report.summary).toMatchObject({ usedLlm: true, error: null });
    expect(report.notesCited.length).toBeGreaterThan(0);
    for (const title of report.notesCited) expect(markdown).toContain(`- ${title}`);
    expect(markdown).toMatch(/Priya/);
  });

  it("writes a plain summary without a Gateway key", async () => {
    const { report, markdown } = await endMeeting("");
    expect(report.summary.usedLlm).toBe(false);
    expect(report.summary.error).toContain("No AI Gateway key");
    expect(markdown).toContain("- Priya will send the renewal quote and the support SLA summary by Friday.");
  });
});
