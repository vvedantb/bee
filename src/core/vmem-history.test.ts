import { describe, expect, it, vi } from "vitest";
import { createVmemHistory, parseHistoryHits } from "./vmem-history";

const memory = (extra: Record<string, unknown>) => ({ id: "m", title: "", content: "", source: "browsing history", ...extra });

describe("parseHistoryHits", () => {
  it("keeps history and bookmark memories on the domain, using the url field when present", () => {
    const hits = parseHistoryHits(
      { memories: [memory({ url: "https://vercel.com/acme/vibot/logs", title: "logs" }), memory({ source: "Bookmark", url: "https://www.vercel.com/docs" })] },
      "vercel.com",
    );
    expect(hits.map((hit) => hit.url)).toEqual(["https://vercel.com/acme/vibot/logs", "https://www.vercel.com/docs"]);
    expect(hits[0]).toMatchObject({ title: "logs", source: "browsing history" });
  });

  it("finds URLs in the title or content when there is no url field", () => {
    const hits = parseHistoryHits({ memories: [memory({ content: "Visited https://vercel.com/acme/vibot/logs. Then left." }), memory({ title: "see (https://vercel.com/a)" })] }, "vercel.com");
    expect(hits.map((hit) => hit.url)).toEqual(["https://vercel.com/acme/vibot/logs", "https://vercel.com/a"]);
  });

  it("skips other sources, other domains, unsafe URLs and memories without a URL", () => {
    const hits = parseHistoryHits(
      {
        memories: [
          memory({ source: "note", url: "https://vercel.com/n" }),
          memory({ url: "https://github.com/x" }),
          memory({ url: "https://vercel.com.evil.example/x" }),
          memory({ url: "https://127.0.0.1/" }),
          memory({ content: "no link here" }),
          null,
          "junk",
        ],
      },
      "vercel.com",
    );
    expect(hits).toEqual([]);
  });

  it("limits to five and tolerates odd results", () => {
    const many = Array.from({ length: 9 }, (_, index) => memory({ url: `https://vercel.com/p${index}` }));
    expect(parseHistoryHits({ memories: many }, "vercel.com")).toHaveLength(5);
    expect(parseHistoryHits(undefined, "vercel.com")).toEqual([]);
    expect(parseHistoryHits({ memories: "x" }, "vercel.com")).toEqual([]);
  });
});

describe("createVmemHistory", () => {
  const result = { memories: [memory({ url: "https://vercel.com/a" })] };

  it("uses search with judge off when the SDK has it", async () => {
    const search = vi.fn(async () => result);
    const hits = await createVmemHistory({ search })("logs for vibot", "vercel.com");
    expect(hits).toHaveLength(1);
    expect(search).toHaveBeenCalledWith("vercel.com logs for vibot", { limit: 20, judge: "off" });
  });

  it("falls back to searchMemories (SDK 0.1.3)", async () => {
    const searchMemories = vi.fn(async () => result);
    expect(await createVmemHistory({ searchMemories })("logs", "vercel.com")).toHaveLength(1);
    expect(searchMemories).toHaveBeenCalledWith({ query: "vercel.com logs", limit: 20 });
  });

  it("caps the query length and propagates errors for the caller to fail open", async () => {
    const search = vi.fn(async () => result);
    await createVmemHistory({ search })("x".repeat(2000), "vercel.com");
    expect((search.mock.calls[0] as unknown as [string])[0]).toHaveLength(300);
    await expect(createVmemHistory({ search: async () => Promise.reject(new Error("401")) })("q", "vercel.com")).rejects.toThrow("401");
  });
});
