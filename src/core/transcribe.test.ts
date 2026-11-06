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

  it("sends known names as xAI keyterm hints, newest first", async () => {
    const doGenerate = vi.fn<Generate>(async () => result("Bee, open Teams"));
    await transcribeSpeech({ model: model(doGenerate), audio, knownNames: ["Chris Lee", "Krzysztof Nowak"] });
    expect(doGenerate.mock.calls[0]?.[0].providerOptions).toEqual({ xai: { keyterm: ["Krzysztof Nowak", "Chris Lee", "Krzysztof", "Chris"] } });
  });

  it("puts a misheard name in its one known spelling on the user's own mic only", async () => {
    const heard = () => model(async () => result("Bee, send Chris a message."));
    expect((await transcribeSpeech({ model: heard(), audio, knownNames: ["Krzysztof Nowak"], remapNames: true })).text).toBe("Bee, send Krzysztof a message.");
    expect((await transcribeSpeech({ model: heard(), audio, knownNames: ["Chris Lee", "Krzysztof Nowak"], remapNames: true })).text).toBe("Bee, send Chris a message.");
    // Other people's speech (Teams audio) keeps its words.
    expect((await transcribeSpeech({ model: heard(), audio, knownNames: ["Krzysztof Nowak"] })).text).toBe("Bee, send Chris a message.");
  });

  it("asks once more without the hints when the provider refuses them, never losing the phrase", async () => {
    const doGenerate = vi.fn<Generate>(async (options) => {
      if (options.providerOptions?.xai) throw Object.assign(new Error("Invalid request: unknown option keyterm"), { statusCode: 400 });
      return result("Bee, open Teams");
    });
    const outcome = await transcribeSpeech({ model: model(doGenerate), audio, knownNames: ["Zuzanna"] });
    expect(outcome).toEqual({ text: "Bee, open Teams", error: null });
    expect(doGenerate).toHaveBeenCalledTimes(2);
    expect(doGenerate.mock.calls[1]?.[0].providerOptions).toEqual({});
  });

  it("does not repeat a call that failed for another reason", async () => {
    const doGenerate = vi.fn<Generate>(async () => {
      throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
    });
    const outcome = await transcribeSpeech({ model: model(doGenerate), audio, knownNames: ["Zuzanna"] });
    expect(outcome.error).toMatch(/^Speech-to-text failed: /);
    expect(doGenerate).toHaveBeenCalledTimes(1);
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
