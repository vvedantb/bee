import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { LUNA_NO_WEB, LUNA_SYSTEM, buildLunaPrompt, guideWithLuna } from "./luna";
import { searchLocation } from "./web-search";

type Chunk = Parameters<typeof simulateReadableStream<unknown>>[0]["chunks"][number];
const answer = (text: string): Chunk[] => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: text },
  { type: "text-end", id: "t" },
  { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: undefined } } },
];

function model(text: string) {
  return new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks: answer(text) }) as never }) });
}

describe("Luna's search and consistency guidance", () => {
  it("steers search to official sources and major outlets, without a domain allow-list", () => {
    for (const name of ["tfl.gov.uk", "gov.uk", "BBC", "Reuters"]) expect(LUNA_SYSTEM).toContain(name);
    expect(LUNA_SYSTEM).toMatch(/Avoid aggregators/);
  });

  it("names the source in the query and the tip, and searches again past blogs and newsletters", () => {
    expect(LUNA_SYSTEM).toContain("Put that source's name in the search query");
    expect(LUNA_SYSTEM).toContain('"TfL planned closures this weekend"');
    expect(LUNA_SYSTEM).toContain('"BBC London news today"');
    expect(LUNA_SYSTEM).toMatch(/only blogs, newsletters, aggregators or local listings, search again/);
    expect(LUNA_SYSTEM).toContain('"per TfL"');
    expect(LUNA_SYSTEM).not.toMatch(/site domain/);
  });

  it("keeps follow-ups consistent and says when sources disagree", () => {
    expect(LUNA_SYSTEM).toMatch(/consistent with your last answer/);
    expect(LUNA_SYSTEM).toMatch(/which lines are closed today, say it changed/);
    expect(LUNA_SYSTEM).toMatch(/If sources disagree on a number, give the range/);
    expect(LUNA_SYSTEM).toMatch(/If they disagree on anything else, state each version in one tip/);
  });

  it("says in the tail when web search is off, and only then", () => {
    const now = new Date("2026-10-24T12:00:00Z");
    expect(buildLunaPrompt({ transcript: ["what is fifteen percent of eighteen thousand"], notes: [], web: false, now }).tail).toContain(LUNA_NO_WEB);
    expect(buildLunaPrompt({ transcript: ["what's in the news"], notes: [], now }).tail).not.toContain(LUNA_NO_WEB);
    // The cached system prompt is the same either way.
    expect(buildLunaPrompt({ transcript: ["x"], notes: [], web: false }).system).toBe(buildLunaPrompt({ transcript: ["x"], notes: [] }).system);
  });
});

describe("guideWithLuna web search switch", () => {
  it("sends no web_search tool when the turn needs none, and keeps provider fail-over", async () => {
    const llm = model("- 2,700\n");
    const result = await guideWithLuna({ model: llm, transcript: ["what is fifteen percent of eighteen thousand"], notes: [], webSearch: false });
    expect(result.tips).toEqual(["2,700"]);
    const call = llm.doStreamCalls[0];
    expect((call?.tools ?? []).map((tool) => tool.name)).not.toContain("web_search");
    expect(call?.providerOptions).toMatchObject({ gateway: { order: ["anthropic"] } });
    expect(JSON.stringify(call?.prompt)).toContain(LUNA_NO_WEB);
  });

  it("sends web_search with the user's location by default", async () => {
    const llm = model("- Planned closures on the District line\n");
    await guideWithLuna({ model: llm, transcript: ["what's in the news in London today"], notes: [], searchLocation: searchLocation({ timeZone: "Europe/London", locale: "en-GB" }) });
    const web = (llm.doStreamCalls[0]?.tools ?? []).find((tool) => tool.name === "web_search");
    expect(web).toMatchObject({ type: "provider", args: { userLocation: { type: "approximate", city: "London", country: "GB", timezone: "Europe/London" } } });
    expect(llm.doStreamCalls[0]?.providerOptions).toMatchObject({ gateway: { only: ["anthropic"] } });
    expect(web).not.toHaveProperty("args.allowedDomains");
  });

  it("never limits web_search to a domain list", async () => {
    const llm = model("- Planned closures on the District line, per TfL\n");
    await guideWithLuna({ model: llm, transcript: ["why are there tube closures"], notes: [], searchLocation: searchLocation({ timeZone: "Europe/London" }) });
    const web = (llm.doStreamCalls[0]?.tools ?? []).find((tool) => tool.name === "web_search");
    expect(web).toMatchObject({ type: "provider" });
    expect(web).not.toHaveProperty("args.allowedDomains");
    expect(web).not.toHaveProperty("args.blockedDomains");
  });
});

describe("guideWithLuna search option errors", () => {
  // The live error from turn 2 of the conversation test, when allowedDomains held bbc.co.uk.
  const DOMAINS_ERROR = "The following domains are not accessible to our user agent: ['bbc.co.uk', 'bbc.com', 'standard.co.uk']";
  const location = searchLocation({ timeZone: "Europe/London", locale: "en-GB" });

  // Fails the first `failures` calls with `message`, then answers. Records each call's web_search tool (or none).
  function failing(message: string, failures: number) {
    let calls = 0;
    return new MockLanguageModelV4({
      doStream: async ({ tools }) => {
        calls++;
        if (calls <= failures) {
          return { stream: simulateReadableStream<unknown>({ chunks: [{ type: "stream-start", warnings: [] }, { type: "error", error: new Error(message) }] }) as never };
        }
        const web = (tools ?? []).some((tool) => tool.name === "web_search");
        return { stream: simulateReadableStream({ chunks: answer(web ? "- Planned works | src: TfL\n" : "- No search this time\n") }) as never };
      },
    });
  }

  const webTools = (llm: MockLanguageModelV4) => llm.doStreamCalls.map((call) => (call.tools ?? []).find((tool) => tool.name === "web_search"));

  it("retries once with web_search but no search options, and answers", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const llm = failing(DOMAINS_ERROR, 1);
      const result = await guideWithLuna({ model: llm, transcript: ["why are there tube closures"], notes: [], searchLocation: location });
      expect(result.error).toBeNull();
      expect(result.tips).toEqual(["Planned works"]);
      expect(result.tipSources).toEqual(["TfL"]);
      const [first, retry] = webTools(llm);
      expect(llm.doStreamCalls).toHaveLength(2);
      expect(first).toHaveProperty("args.userLocation");
      expect(retry).toMatchObject({ type: "provider" });
      expect(retry).not.toHaveProperty("args.userLocation");
    } finally {
      warn.mockRestore();
    }
  });

  it("drops web_search when the option-free retry is rejected too, so the turn still gets an answer", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const llm = failing(DOMAINS_ERROR, 2);
      const result = await guideWithLuna({ model: llm, transcript: ["why are there tube closures"], notes: [], searchLocation: location });
      expect(result.error).toBeNull();
      expect(result.tips).toEqual(["No search this time"]);
      expect(llm.doStreamCalls).toHaveLength(3);
      expect(webTools(llm)[2]).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    "web_search: allowed_domains contains an invalid domain",
    "Invalid user_location for the web search tool",
    "web search tool: blocked_domains and allowed_domains cannot both be set",
  ])("retries on %s", async (message) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const llm = failing(message, 1);
      expect((await guideWithLuna({ model: llm, transcript: ["what's in the news today"], notes: [], searchLocation: location })).error).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it("does not retry an unrelated error, or a turn without web_search", async () => {
    const llm = failing("Rate limit exceeded", 1);
    expect((await guideWithLuna({ model: llm, transcript: ["what's in the news today"], notes: [] })).error).toBe("AI guidance failed: Rate limit exceeded");
    const noWeb = failing(DOMAINS_ERROR, 1);
    expect((await guideWithLuna({ model: noWeb, transcript: ["what is 2 plus 2"], notes: [], webSearch: false })).error).toContain("not accessible to our user agent");
    expect(noWeb.doStreamCalls).toHaveLength(1);
  });
});
