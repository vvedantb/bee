import { describe, expect, it } from "vitest";
import { z } from "zod";
import { pipelineResultSchema } from "../src/shared/ipc";
import { root, runHarness } from "./e2e/run";

// Electron E2E of the mic path with Chromium's fake audio device playing test/fixtures/sso-question.wav:
// Web Audio capture → segmenter → WAV → preload → main → live Grok STT → retrieve → Jev → Luna.
// Needs BEE_AI_GATEWAY_API_KEY and a built preload (npm run test:e2e builds it).

const reportSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    line: z.string(),
    sampleRate: z.number(),
    frames: z.number(),
    peakLevel: z.number(),
    pipeline: pipelineResultSchema,
  }),
  z.object({ ok: z.literal(false), stage: z.string(), error: z.string().optional() }),
]);

describe("mic → Grok STT → pipeline (Electron E2E)", () => {
  it("turns fake-mic speech into a transcript line and tips, with no transcript UI", async () => {
    if (!process.env.BEE_AI_GATEWAY_API_KEY?.trim()) throw new Error("BEE_AI_GATEWAY_API_KEY is not set.");
    const report = await runHarness({
      page: "harness-page",
      env: { BEE_E2E_AUDIO: `${root}test/fixtures/sso-question.wav` },
      report: reportSchema,
    });
    console.log("E2E report:", JSON.stringify(report, null, 2));
    if (!report.ok) throw new Error(`E2E failed at ${report.stage}: ${report.error ?? ""}`);
    expect(report.peakLevel).toBeGreaterThan(0.01);
    expect(report.line).toMatch(/SSO ship/i);
    expect(report.pipeline.notes[0]?.title).toBe("Q4 product roadmap › Dates");
    expect(report.pipeline.rankSource).toBe("jev");
    expect(report.pipeline.tips.length).toBeGreaterThan(0);
  });
});
