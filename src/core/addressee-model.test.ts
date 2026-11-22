import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "@ai-sdk/gateway";
import { describe, expect, it } from "vitest";
import fixture from "../../test/fixtures/addressee/cases.json";
import { decideAddressee, type AddresseeInput } from "./addressee-check";
import { addresseePrompt, askAddresseeModel } from "./addressee-model";
import { ADDRESSEE_MODEL } from "./gateway";

describe("addresseePrompt", () => {
  it("carries Bee's last exchange, the last three lines and the phrase, and nothing else", () => {
    const prompt = addresseePrompt({ phrase: "the Q3 tab", lastBee: fixture.lastBee, lines: ["me: a", "them: b", "me: c", "them: d"], othersQuiet: true });
    expect(prompt).toContain("Open the Acme budget page");
    expect(prompt).toContain("- them: b\n- me: c\n- them: d");
    expect(prompt).not.toContain("- me: a");
    expect(prompt).toContain("New phrase from the user: the Q3 tab");
    expect(prompt).toContain("lean toward Bee");
    expect(addresseePrompt({ phrase: "x", lastBee: fixture.lastBee, lines: [], othersQuiet: false })).toContain("Someone else spoke");
  });
});

// One small real batch on Haiku, only with a key in the environment: prints accuracy. Skipped without one.
const key = process.env.BEE_AI_GATEWAY_API_KEY ?? "";
describe.skipIf(key === "")("addressee check on the Gateway (real model)", () => {
  it("scores the fixture cases that reach the model", async () => {
    const model = createGateway({ apiKey: key }).languageModel(ADDRESSEE_MODEL);
    const cases = fixture.cases.filter((item) => item.prefilter === "run" && "model" in item && item.model !== null);
    let correct = 0;
    const report: string[] = [];
    for (const item of cases) {
      const input: AddresseeInput = { phrase: item.phrase, lastBee: fixture.lastBee, lines: item.lines, participants: fixture.participants, conversationOpen: true, othersQuiet: true };
      const result = await decideAddressee({ input, enabled: true, classify: (value) => askAddresseeModel({ model, input: value, timeoutMs: 8000 }) });
      if (result.decision === item.decision) correct += 1;
      const line = `addressee ${item.id}: ${result.decision} (expected ${item.decision}) reason ${result.reason} score ${result.score} ${result.latencyMs} ms`;
      report.push(line);
      console.info(line);
    }
    const summary = `addressee accuracy: ${correct}/${cases.length}`;
    const path = join(tmpdir(), "bee-addressee-report.txt");
    writeFileSync(path, [summary, ...report, ""].join("\n"));
    console.info(`${summary} (report: ${path})`);
    expect(correct, `${summary}\n${report.join("\n")}\nreport: ${path}`).toBeGreaterThanOrEqual(Math.floor(cases.length * 0.7));
  }, 120_000);
});
