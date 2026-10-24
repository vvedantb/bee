import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BeeGateway } from "./gateway";
import { rankWithJev } from "./jev";
import { guideWithLuna } from "./luna";
import { runPipeline } from "./pipeline";
import { searchLocation } from "./web-search";

vi.mock("./jev", () => ({ rankWithJev: vi.fn() }));
vi.mock("./luna", async (importOriginal) => ({ ...(await importOriginal<typeof import("./luna")>()), guideWithLuna: vi.fn() }));

const rank = vi.mocked(rankWithJev);
const guide = vi.mocked(guideWithLuna);
const gateway = { languageModel: () => ({}), evaluationModel: () => ({}) } as unknown as BeeGateway;
const NEWS = "what's in the news in London today";
const WHY = "why are there tube closures";
const SUM = "what is fifteen percent of eighteen thousand";

beforeEach(() => {
  rank.mockReset();
  guide.mockReset();
  rank.mockResolvedValue({ ranked: [], source: "fallback", error: null });
  guide.mockResolvedValue({ tips: ["x"], tipSources: [null], sources: [], error: null, skipped: null, firstTokenMs: 1, totalMs: 2 });
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

/** What runPipeline asked Luna for: web search on or off, and the location. */
async function guideArgs(args: Partial<Parameters<typeof runPipeline>[0]> & { transcript: string[] }) {
  await runPipeline({ snippets: [], gateway, ...args });
  return guide.mock.calls[0]?.[0];
}

describe("runPipeline web search", () => {
  it("searches for the news", async () => {
    expect((await guideArgs({ transcript: [NEWS], turnLines: 1 }))?.webSearch).toBe(true);
  });

  it("does not search for a sum, even after a searched answer", async () => {
    expect((await guideArgs({ transcript: [NEWS, WHY, SUM], turnLines: 1, earlier: ["Weekend closures are planned engineering works"], searched: true }))?.webSearch).toBe(false);
  });

  it("searches a follow-up to a searched answer", async () => {
    expect((await guideArgs({ transcript: [NEWS, "and the Elizabeth line"], turnLines: 1, earlier: ["District line closed Saturday"], searched: true }))?.webSearch).toBe(true);
    guide.mockClear();
    expect((await guideArgs({ transcript: [NEWS, WHY], turnLines: 1, earlier: ["District line closed Saturday"], searched: true }))?.webSearch).toBe(true);
  });

  it("reads only the turn's lines as the request; earlier lines are context", async () => {
    // The news line is context: plain talk after it is a follow-up, so it keeps search.
    expect((await guideArgs({ transcript: [NEWS, "let's park that"], turnLines: 1 }))?.webSearch).toBe(true);
    guide.mockClear();
    expect((await guideArgs({ transcript: ["let's pick up the Acme renewal"], turnLines: 1 }))?.webSearch).toBe(false);
  });

  it("passes the location through to Luna", async () => {
    const location = searchLocation({ timeZone: "Europe/London", locale: "en-GB" });
    expect((await guideArgs({ transcript: [NEWS], searchLocation: location }))?.searchLocation).toEqual(location);
  });

  it("never narrows search to a domain list, even for a tube question", async () => {
    expect(await guideArgs({ transcript: [NEWS, WHY], turnLines: 1, searched: true })).not.toHaveProperty("searchDomains");
  });
});
