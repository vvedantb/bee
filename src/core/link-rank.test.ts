import { describe, expect, it, vi } from "vitest";
import { LINK_MIN_SCORE, applyDecision, buildCandidate, canPersonalise, chipLabel, createLinkEnricher, type EnrichDeps, type HistoryHit, type LinkDecision } from "./link-rank";
import type { LinkChip } from "./link-suggest";

const vercel: LinkChip = { id: "vercel.com", domain: "vercel.com", url: "https://vercel.com/", label: "vercel.com" };
const github: LinkChip = { id: "github.com", domain: "github.com", url: "https://github.com/", label: "github.com" };
const logs: HistoryHit = { url: "https://vercel.com/acme/vibot/logs?utm_source=x", title: "vibot logs", source: "browsing history" };
const other: HistoryHit = { url: "https://vercel.com/acme/other", title: "other", source: "bookmark" };
const turn = "vercel logs for vibot";

function deps(hits: HistoryHit[], decision: LinkDecision | Error | "hang") {
  const search = vi.fn(async () => hits);
  const decide = vi.fn(async (_turn: string, _candidate: unknown, signal: AbortSignal) => {
    if (decision === "hang") return new Promise<LinkDecision>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    if (decision instanceof Error) throw decision;
    return decision;
  });
  return { searchHistory: search, decide, search };
}

describe("chipLabel", () => {
  it("shows host and path segments", () => {
    expect(chipLabel("https://vercel.com/acme/vibot/logs")).toBe("vercel.com › acme › vibot › logs");
  });
  it("strips www, query and hash, and skips empty segments", () => {
    expect(chipLabel("https://www.github.com//a///b/?q=1#frag")).toBe("github.com › a › b");
  });
  it("is just the host for the homepage", () => {
    expect(chipLabel("https://vercel.com/")).toBe("vercel.com");
  });
  it("caps segments and their length", () => {
    expect(chipLabel("https://x.io/a/b/c/d/e")).toBe("x.io › a › b › c");
    expect(chipLabel(`https://x.io/${"z".repeat(40)}`)).toBe(`x.io › ${"z".repeat(23)}…`);
  });
  it("decodes segments and survives bad escapes", () => {
    expect(chipLabel("https://x.io/my%20page/%E0%A4%A")).toBe("x.io › my page › %E0%A4%A");
  });
});

describe("buildCandidate", () => {
  it("lists safe history pages on the domain, deduped, then the plain URL last", () => {
    const hits: HistoryHit[] = [
      logs,
      { ...logs },
      other,
      { url: "https://evil.example/x", title: "elsewhere", source: "bookmark" },
      { url: "https://www.vercel.com/www", title: "www", source: "bookmark" },
      { url: "https://127.0.0.1/", title: "loopback", source: "bookmark" },
      { url: "https://vercel.com/", title: "home", source: "bookmark" },
    ];
    const urls = buildCandidate(vercel, hits).urls.map((item) => item.url);
    expect(urls).toEqual(["https://vercel.com/acme/vibot/logs", "https://vercel.com/acme/other", "https://www.vercel.com/www", "https://vercel.com/"]);
  });

  it("keeps at most five history pages", () => {
    const hits = Array.from({ length: 9 }, (_, index): HistoryHit => ({ url: `https://vercel.com/p${index}`, title: "p", source: "bookmark" }));
    expect(buildCandidate(vercel, hits).urls).toHaveLength(6);
  });
});

describe("applyDecision", () => {
  const candidate = buildCandidate(vercel, [logs, other]);
  const at = (suggest: number | null, urls: Array<number | null>) => applyDecision(vercel, candidate, { suggest, urls });

  it("picks the best URL at or above the cut-off", () => {
    expect(at(3, [2.5, 3, 1])).toMatchObject({ url: "https://vercel.com/acme/other", label: "vercel.com › acme › other", id: "vercel.com", domain: "vercel.com" });
  });
  it("breaks ties towards the earlier candidate", () => {
    expect(at(2, [2, 2, 2])?.url).toBe("https://vercel.com/acme/vibot/logs");
  });
  it("drops the chip when the suggest score is below the cut-off", () => {
    expect(at(LINK_MIN_SCORE - 0.1, [3, 3, 3])).toBeNull();
  });
  it("keeps the plain chip when no URL reaches the cut-off", () => {
    expect(at(3, [1, 1.9, 0])).toBe(vercel);
  });
  it("keeps the plain chip for missing, invalid or out-of-range scores", () => {
    expect(at(null, [3, 3, 3])).toBe(vercel);
    expect(at(Number.NaN, [3, 3, 3])).toBe(vercel);
    expect(at(7, [3, 3, 3])).toBe(vercel);
    expect(applyDecision(vercel, candidate, null)).toBe(vercel);
  });
  it("ignores URL scores that are invalid", () => {
    expect(at(3, [null, Number.NaN, 2.5])).toBe(vercel);
  });
});

describe("canPersonalise", () => {
  it("needs the toggle and the Gateway key; vmem is optional", () => {
    expect(canPersonalise({ enabled: true, hasVmem: true, hasGatewayKey: true })).toBe(true);
    expect(canPersonalise({ enabled: true, hasVmem: false, hasGatewayKey: true })).toBe(true);
    expect(canPersonalise({ enabled: true, hasGatewayKey: true })).toBe(true);
    expect(canPersonalise({ enabled: false, hasVmem: true, hasGatewayKey: true })).toBe(false);
    expect(canPersonalise({ enabled: true, hasVmem: true, hasGatewayKey: false })).toBe(false);
  });
});

describe("createLinkEnricher", () => {
  it("picks a history URL above the cut-off and keeps the detector's order", async () => {
    const d = deps([logs], { suggest: 3, urls: [3, 1] });
    const enrich = createLinkEnricher({ getDeps: () => d });
    const out = await enrich(turn, [github, vercel]);
    expect(out.map((chip) => chip.id)).toEqual(["github.com", "vercel.com"]);
    // Both chips get the same fake decision here; the point is order and the vercel deep link.
    expect(out[1]).toMatchObject({ url: "https://vercel.com/acme/vibot/logs", label: "vercel.com › acme › vibot › logs" });
  });

  it("drops a chip when Jev says no", async () => {
    const enrich = createLinkEnricher({ getDeps: () => deps([logs], { suggest: 0.5, urls: [3, 3] }) });
    expect(await enrich(turn, [vercel])).toEqual([]);
  });

  it("falls back to the plain chip when Jev fails or returns no scores", async () => {
    const failing = createLinkEnricher({ getDeps: () => deps([logs], new Error("gateway down")) });
    expect(await failing(turn, [vercel])).toEqual([vercel]);
    const empty = createLinkEnricher({ getDeps: () => deps([logs], { suggest: null, urls: [null, null] }) });
    expect(await empty(turn, [vercel])).toEqual([vercel]);
  });

  it("still asks Jev when vmem fails, and keeps the plain chip", async () => {
    const d = deps([], { suggest: 3, urls: [3] });
    d.searchHistory = vi.fn(async (): Promise<HistoryHit[]> => {
      throw new Error("vmem down");
    });
    const out = await createLinkEnricher({ getDeps: () => d })(turn, [vercel]);
    expect(out).toEqual([vercel]);
    expect(d.decide).toHaveBeenCalledTimes(1);
  });

  it("returns the plain chips on timeout", async () => {
    const enrich = createLinkEnricher({ getDeps: () => deps([logs], "hang"), timeoutMs: 20 });
    expect(await enrich(turn, [vercel, github])).toEqual([vercel, github]);
  });

  it("scores the plain domain chip with Jev alone when history search returns []", async () => {
    const d = deps([], { suggest: 3, urls: [3] });
    const enrich = createLinkEnricher({ getDeps: () => d });
    expect(await enrich(turn, [vercel])).toEqual([vercel]);
    expect(d.decide).toHaveBeenCalledTimes(1);
    expect(d.decide.mock.calls[0]?.[1]).toEqual({ domain: "vercel.com", urls: [{ url: "https://vercel.com/", title: "vercel.com" }] });
    const dropped = deps([], { suggest: 0, urls: [3] });
    expect(await createLinkEnricher({ getDeps: () => dropped })(`${turn} 2`, [vercel])).toEqual([]);
  });

  it("reports why it fell back: timeout, Jev failure and history failure", async () => {
    const onFallback = vi.fn();
    await createLinkEnricher({ getDeps: () => deps([logs], "hang"), timeoutMs: 20, onFallback })(turn, [vercel]);
    expect(onFallback).toHaveBeenCalledWith(expect.stringMatching(/timed out/));

    const jev = vi.fn();
    await createLinkEnricher({ getDeps: () => deps([logs], new Error("gateway down")), onFallback: jev })(turn, [vercel]);
    expect(jev).toHaveBeenCalledWith("Jev failed: gateway down");

    const history = vi.fn();
    const d = deps([], { suggest: 3, urls: [3] });
    d.searchHistory = vi.fn(async (): Promise<HistoryHit[]> => {
      throw new Error("mcp down");
    });
    await createLinkEnricher({ getDeps: () => d, onFallback: history })(turn, [vercel]);
    expect(history).toHaveBeenCalledWith("history search failed: mcp down");
  });

  it("does not call onFallback on a clean run", async () => {
    const onFallback = vi.fn();
    await createLinkEnricher({ getDeps: () => deps([logs], { suggest: 3, urls: [3, 1] }), onFallback })(turn, [vercel]);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("makes no calls when the detector found nothing", async () => {
    const d = deps([logs], { suggest: 3, urls: [3, 3] });
    const getDeps = vi.fn(() => d);
    expect(await createLinkEnricher({ getDeps })(turn, [])).toEqual([]);
    expect(getDeps).not.toHaveBeenCalled();
    expect(d.search).not.toHaveBeenCalled();
    expect(d.decide).not.toHaveBeenCalled();
  });

  it("makes no calls and returns plain chips when personalising is off or keys are missing", async () => {
    const enrich = createLinkEnricher({ getDeps: () => null });
    expect(await enrich(turn, [vercel])).toEqual([vercel]);
  });

  it("does not call twice for the same turn and chips, even while the first call runs", async () => {
    const d = deps([logs], { suggest: 3, urls: [3, 1] });
    const enrich = createLinkEnricher({ getDeps: () => d });
    const [first, second] = await Promise.all([enrich(turn, [vercel]), enrich(turn, [vercel])]);
    await enrich(turn, [vercel]);
    expect(second).toBe(first);
    expect(d.search).toHaveBeenCalledTimes(1);
    expect(d.decide).toHaveBeenCalledTimes(1);
    await enrich(`${turn} again`, [vercel]);
    expect(d.search).toHaveBeenCalledTimes(2);
  });
});
