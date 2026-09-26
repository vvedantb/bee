import type { TranscriptionModel } from "ai";
import { describe, expect, it, vi } from "vitest";
import { transcribeSpeech } from "./transcribe";

type ModelV4 = Extract<TranscriptionModel, { specificationVersion: "v4" }>;
type Generate = ModelV4["doGenerate"];

function model(doGenerate: Generate): ModelV4 {
  return { specificationVersion: "v4", provider: "gateway", modelId: "xai/grok-stt", doGenerate };
}

function result(text: string): Awaited<ReturnType<Generate>> {
  return {
    text,
    segments: [],
    language: "en",
    durationInSeconds: 1,
    warnings: [],
    response: { timestamp: new Date(), modelId: "xai/grok-stt" },
  };
}

const audio = new Uint8Array(100);

describe("transcribeSpeech", () => {
  it("returns tidy text and sends flex tier with no sampling options", async () => {
    const doGenerate = vi.fn<Generate>(async () => result("  When does SSO\n ship? "));
    const outcome = await transcribeSpeech({ model: model(doGenerate), audio });
    expect(outcome).toEqual({ text: "When does SSO ship?", error: null });
    const call = doGenerate.mock.calls[0]?.[0];
    expect(call?.providerOptions).toEqual({ gateway: { serviceTier: "flex" } });
    expect(call?.audio).toEqual(audio);
  });

  it("treats empty or punctuation-only output as no words", async () => {
    for (const text of ["", " . ", "…"]) {
      const outcome = await transcribeSpeech({ model: model(async () => result(text)), audio });
      expect(outcome).toEqual({ text: null, error: null });
    }
  });

  it("reports failures as a short error instead of throwing", async () => {
    const outcome = await transcribeSpeech({
      model: model(async () => {
        throw new Error("Unauthorized");
      }),
      audio,
    });
    expect(outcome.text).toBeNull();
    expect(outcome.error).toMatch(/^Speech-to-text failed: /);
  });
});
