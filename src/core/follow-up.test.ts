import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FOLLOW_UP_SYSTEM, classifyFollowUp, followUpPrompt, parseFollowUp } from "./follow-up";

// The conversation window's one small AI call, with a mock model: no network.

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
const lastBee = { request: "open the team usage", reply: "Which team?" };

function model(reply: string | Error) {
  const prompts: string[] = [];
  const mock = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      if (reply instanceof Error) throw reply;
      return { content: [{ type: "text", text: reply }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
    },
  });
  return { mock, prompts };
}

beforeEach(() => {
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("follow-up check", () => {
  it("builds a tiny prompt: Bee's last exchange, three labelled lines, the phrase", () => {
    const prompt = followUpPrompt({ lastBee, lines: ["me: hello", "them: hi", "me: one", "them: two"], phrase: "the Acme one", othersQuiet: true });
    expect(prompt).toContain("The user asked Bee: open the team usage");
    expect(prompt).toContain("Bee answered: Which team?");
    expect(prompt).not.toContain("me: hello");
    expect(prompt).toContain("- them: two");
    expect(prompt).toContain("lean toward Bee");
    expect(prompt.endsWith("New phrase from the user: the Acme one")).toBe(true);
    expect(followUpPrompt({ lastBee, lines: [], phrase: "x", othersQuiet: false })).toContain("Someone else spoke in the last minute.");
    expect(FOLLOW_UP_SYSTEM).not.toMatch(/claude|haiku|anthropic/i);
  });

  it("parses the JSON verdict, and nothing else", () => {
    expect(parseFollowUp('{"addressed":"bee","confidence":0.82}')).toEqual({ addressed: "bee", confidence: 0.82 });
    expect(parseFollowUp('Sure: {"addressed": "meeting", "confidence": "0.9"}')).toEqual({ addressed: "meeting", confidence: 0.9 });
    expect(parseFollowUp('{"addressed":"them","confidence":0.9}')).toBeNull();
    expect(parseFollowUp('{"addressed":"bee","confidence":7}')).toBeNull();
    expect(parseFollowUp("bee")).toBeNull();
  });

  it("asks the model once and returns its verdict", async () => {
    const { mock, prompts } = model('{"addressed":"bee","confidence":0.9}');
    expect(await classifyFollowUp({ model: mock, lastBee, lines: ["me: open the team usage"], phrase: "the Acme one", othersQuiet: true })).toEqual({ addressed: "bee", confidence: 0.9 });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("the Acme one");
  });

  it("is null on a failure, so the phrase stays a meeting line", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await classifyFollowUp({ model: model(new Error("boom")).mock, lastBee, lines: [], phrase: "x", othersQuiet: true })).toBeNull();
    expect(await classifyFollowUp({ model: model("not json").mock, lastBee, lines: [], phrase: "x", othersQuiet: true })).toBeNull();
  });
});
