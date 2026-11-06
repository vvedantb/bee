import type { TranscriptionModel } from "ai";
import { describe, expect, it, vi } from "vitest";
import { STT_TERMS, sttVocabulary, transcribeSpeech } from "./transcribe";

type ModelV4 = Extract<TranscriptionModel, { specificationVersion: "v4" }>;
type Generate = ModelV4["doGenerate"];

function model(doGenerate: Generate): ModelV4 {
  return { specificationVersion: "v4", provider: "gateway", modelId: "mistral/voxtral-small-transcribe-3", doGenerate };
}

function result(text: string): Awaited<ReturnType<Generate>> {
  return {
    text,
    segments: [],
    language: "en",
    durationInSeconds: 1,
    warnings: [],
    response: { timestamp: new Date(), modelId: "mistral/voxtral-small-transcribe-3" },
  };
}

const audio = new Uint8Array(100);

describe("transcribeSpeech", () => {
  it("returns tidy text and does not send flex tier (user-facing), with no sampling options", async () => {
    const doGenerate = vi.fn<Generate>(async () => result("  When does SSO\n ship? "));
    const outcome = await transcribeSpeech({ model: model(doGenerate), audio });
    expect(outcome).toEqual({ text: "When does SSO ship?", error: null });
    const call = doGenerate.mock.calls[0]?.[0];
    // Gateway default tier: no serviceTier at all. Flex may queue, and ultrafast may be rejected.
    expect(call?.providerOptions).toEqual({});
    expect(JSON.stringify(call?.providerOptions)).not.toMatch(/flex|ultrafast/);
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

  it("sends the words to listen for as Mistral's contextBias, and nothing when there are none", async () => {
    const doGenerate = vi.fn<Generate>(async () => result("Bee, message Zuzanna"));
    await transcribeSpeech({ model: model(doGenerate), audio, vocabulary: ["Bee", "Zuzanna Szczepaniak-Moody"] });
    expect(doGenerate.mock.calls[0]?.[0].providerOptions).toEqual({ mistral: { contextBias: ["Bee", "Zuzanna Szczepaniak-Moody"] } });
    await transcribeSpeech({ model: model(doGenerate), audio, vocabulary: [] });
    expect(doGenerate.mock.calls[1]?.[0].providerOptions).toEqual({});
  });
});

describe("sttVocabulary", () => {
  it("puts Bee's terms first, then the newest known names, with no repeats and at most 100 words", () => {
    expect(sttVocabulary(["Priya", "Zuzanna", "bee", "Bee"])).toEqual([...STT_TERMS, "Zuzanna", "Priya"]);
    const many = sttVocabulary(Array.from({ length: 300 }, (_, i) => `Name${i}`));
    expect(many).toHaveLength(100);
    expect(many[STT_TERMS.length]).toBe("Name299");
  });
});
