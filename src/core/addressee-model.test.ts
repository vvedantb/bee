import { createGateway } from "@ai-sdk/gateway";
import { describe, expect, it } from "vitest";
import fixture from "../../test/fixtures/addressee/cases.json";
import { decideAddressee, type AddresseeInput } from "./addressee-check";
import { addresseePrompt, askAddresseeModel } from "./addressee-model";
import { ADDRESSEE_MODEL } from "./gateway";

describe("addresseePrompt", () => {
  it("carries Bee's last exchange, the last three lines and the phrase, and nothing else", () => {
    const prompt = addresseePrompt({ phrase: "the Q3 tab", lastBee: fixture.lastBee, lines: ["me: a", "them: b", "me: c", "them: d"] });
    expect(prompt).toContain("Open the Acme budget page");
    expect(prompt).toContain("- them: b\n- me: c\n- them: d");
    expect(prompt).not.toContain("- me: a");
    expect(prompt).toContain("New phrase from the user: the Q3 tab");
  });
});

// One small real batch on Haiku, only with a key in the environment: prints accuracy. Skipped without one.
const key = process.env.BEE_AI_GATEWAY_API_KEY ?? "";
describe.skipIf(key === "")("addressee check on the Gateway (real model)", () => {
  it("scores the fixture cases that reach the model", async () => {
    const model = createGateway({ apiKey: key }).languageModel(ADDRESSEE_MODEL);
    const cases = fixture.cases.filter((item) => item.prefilter === "run" && "model" in item && item.model !== null);
    let correct = 0;
    for (const item of cases) {
      const input: AddresseeInput = { phrase: item.phrase, lastBee: fixture.lastBee, lines: item.lines, participants: fixture.participants, conversationOpen: true, othersQuiet: true };
      const result = await decideAddressee({ input, enabled: true, classify: (value) => askAddresseeModel({ model, input: value, timeoutMs: 8000 }) });
      if (result.decision === item.decision) correct += 1;
      console.info(`addressee ${item.id}: ${result.decision} (expected ${item.decision}) score ${result.score} ${result.latencyMs} ms`);
    }
    console.info(`addressee accuracy: ${correct}/${cases.length}`);
    expect(correct).toBeGreaterThanOrEqual(Math.floor(cases.length * 0.7));
  }, 120_000);
});
