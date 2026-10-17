import { describe, expect, it, vi } from "vitest";
import type { McpConnection, McpServerConfig } from "./mcp";
import { createVmemHistory, createVmemSearch, mergeSearchOutputs, parseHistoryHits, pickSearchTool, searchArguments, searchSources } from "./vmem-history";

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

  it("tolerates a missing trace, scoreBreakdown and optional fields", () => {
    const hits = parseHistoryHits({ memories: [{ url: "https://vercel.com/a", source: "browsing history", trace: undefined }, { url: "https://vercel.com/b", source: "bookmark", scoreBreakdown: null }, { url: "https://vercel.com/c" }] }, "vercel.com");
    expect(hits.map((hit) => hit.url)).toEqual(["https://vercel.com/a", "https://vercel.com/b", "https://vercel.com/c"]);
    expect(hits[0]).toMatchObject({ title: "", source: "browsing history" });
  });

  it("parses the URL from content when there is no url field, and ignores non-string url fields", () => {
    const hits = parseHistoryHits([{ url: 42, content: "Opened https://vercel.com/acme/logs, then closed it", source: "history" }], "vercel.com");
    expect(hits.map((hit) => hit.url)).toEqual(["https://vercel.com/acme/logs"]);
  });

  it("keeps an on-domain URL when the source is missing, but not an off-domain one", () => {
    const hits = parseHistoryHits({ results: [{ url: "https://vercel.com/a" }, { url: "https://github.com/a" }, { url: "https://vercel.com/b", source: "note" }] }, "vercel.com");
    expect(hits.map((hit) => hit.url)).toEqual(["https://vercel.com/a"]);
  });

  it("returns [] for garbage and non-JSON strings, without throwing", () => {
    for (const garbage of ["", "   ", "no memories found", "{broken", "[1, 2", "null", "42", "{\"memories\": 5}"]) {
      expect(parseHistoryHits(garbage, "vercel.com")).toEqual([]);
    }
    expect(parseHistoryHits({ memories: [[], 3, { url: { x: 1 }, title: 4, content: null }] }, "vercel.com")).toEqual([]);
  });

  it("parses a JSON string, and JSON embedded in surrounding text", () => {
    const body = JSON.stringify({ memories: [memory({ url: "https://vercel.com/a" })] });
    expect(parseHistoryHits(body, "vercel.com")).toHaveLength(1);
    expect(parseHistoryHits(`Found 1 memory:\n${body}\nDone.`, "vercel.com")).toHaveLength(1);
    expect(parseHistoryHits(`Results: ${JSON.stringify([memory({ url: "https://vercel.com/a" })])}`, "vercel.com")).toHaveLength(1);
  });

  it("handles mixed wrapper shapes: top-level array, memories, results, data and wrapped memories", () => {
    const a = memory({ url: "https://vercel.com/a" });
    const b = { score: 0.9, memory: { title: "b", source: "bookmark", url: "https://vercel.com/b" } };
    const c = { score: 0.5, memory: { content: "see https://vercel.com/c", source: "browsing history" } };
    expect(parseHistoryHits([a, b, c], "vercel.com").map((hit) => hit.url)).toEqual(["https://vercel.com/a", "https://vercel.com/b", "https://vercel.com/c"]);
    expect(parseHistoryHits({ data: { memories: [b] } }, "vercel.com").map((hit) => hit.url)).toEqual(["https://vercel.com/b"]);
    expect(parseHistoryHits({ data: [c] }, "vercel.com").map((hit) => hit.url)).toEqual(["https://vercel.com/c"]);
    expect(parseHistoryHits({ results: [a, "junk", null, b] }, "vercel.com")).toHaveLength(2);
    expect(parseHistoryHits({ results: [b] }, "vercel.com")[0]).toMatchObject({ title: "b", source: "bookmark" });
  });
});

describe("createVmemHistory", () => {
  const result = { memories: [memory({ url: "https://vercel.com/a" })] };

  it("prefixes the domain to the query and parses the result", async () => {
    const callSearch = vi.fn(async () => result);
    const hits = await createVmemHistory(callSearch)("logs for vibot", "vercel.com");
    expect(hits).toHaveLength(1);
    expect(callSearch).toHaveBeenCalledWith("vercel.com logs for vibot", "vercel.com");
  });

  it("caps the query length", async () => {
    const callSearch = vi.fn(async () => result);
    await createVmemHistory(callSearch)("x".repeat(2000), "vercel.com");
    expect((callSearch.mock.calls[0] as unknown as [string])[0]).toHaveLength(300);
  });

  it("returns [] and reports why when the call fails", async () => {
    const onFallback = vi.fn();
    expect(await createVmemHistory(async () => Promise.reject(new Error("Connecting timed out")), onFallback)("q", "vercel.com")).toEqual([]);
    expect(onFallback).toHaveBeenCalledWith("vmem search failed: Connecting timed out");
  });

  it("returns [] and reports when the output is not JSON, but stays quiet on a valid empty result", async () => {
    const onFallback = vi.fn();
    expect(await createVmemHistory(async () => "Sorry, something went wrong", onFallback)("q", "vercel.com")).toEqual([]);
    expect(onFallback).toHaveBeenCalledWith("vmem search output could not be parsed");
    onFallback.mockClear();
    expect(await createVmemHistory(async () => '{"memories": []}', onFallback)("q", "vercel.com")).toEqual([]);
    expect(onFallback).not.toHaveBeenCalled();
  });
});

describe("pickSearchTool and searchArguments", () => {
  const tool = (name: string, properties?: Record<string, unknown>) => ({ name, description: "", inputSchema: { type: "object", properties } });

  it("prefers memory_search, then search, then a name with memory and search", () => {
    expect(pickSearchTool([tool("search"), tool("memory_search")])?.name).toBe("memory_search");
    expect(pickSearchTool([tool("remember"), tool("search")])?.name).toBe("search");
    expect(pickSearchTool([tool("remember"), tool("Search_Memory_v2")])?.name).toBe("Search_Memory_v2");
    expect(pickSearchTool([tool("remember"), tool("forget")])).toBeUndefined();
    expect(pickSearchTool([])).toBeUndefined();
  });

  it("sends query and limit, and source only when given and the schema has it", () => {
    expect(searchArguments(tool("search", { query: {}, limit: {} }), "q")).toEqual({ query: "q", limit: 20 });
    expect(searchArguments(tool("search", { query: {}, limit: {}, source: { type: "string" } }), "q", "bookmark")).toEqual({ query: "q", limit: 20, source: "bookmark" });
    expect(searchArguments(tool("search", { query: {} }), "q", "bookmark")).toEqual({ query: "q" });
    expect(searchArguments(tool("search"), "q")).toEqual({ query: "q", limit: 20 });
  });

  it("searches history and bookmarks, one call each", () => {
    expect(searchSources(tool("search", { source: { type: "string" } }))).toEqual(["browsing-history", "bookmark"]);
    expect(searchSources(tool("search"))).toEqual([undefined]);
  });

  it("never picks a source that an enum does not list", () => {
    expect(searchSources(tool("search", { source: { enum: ["note", "Browsing History", "bookmarks"] } }))).toEqual(["Browsing History", "bookmarks"]);
    expect(searchSources(tool("search", { source: { enum: ["note", "browsing-history"] } }))).toEqual(["browsing-history"]);
    expect(searchSources(tool("search", { source: { enum: ["note", "chat"] } }))).toEqual([undefined]);
  });
});

describe("mergeSearchOutputs", () => {
  it("joins result lists, and keeps URLs from plain text", () => {
    const merged = mergeSearchOutputs([JSON.stringify({ memories: [{ url: "https://a.com/1" }] }), JSON.stringify([{ url: "https://a.com/2" }]), "see https://a.com/3", ""]);
    expect(parseHistoryHits(merged, "a.com").map((hit) => hit.url)).toEqual(["https://a.com/1", "https://a.com/2", "https://a.com/3"]);
  });
});

describe("createVmemSearch", () => {
  const config = (extra: Partial<McpServerConfig> = {}): McpServerConfig => ({ id: "v", name: "vmem", transport: "http", url: "https://mcp.test/mcp", auth: { type: "none" }, oauthSignedIn: true, ...extra });
  const searchTool = { name: "memory_search", description: "", inputSchema: { type: "object", properties: { query: {}, source: { type: "string" } } } };

  function fakeConnect(call: McpConnection["call"] = async () => JSON.stringify({ memories: [] })) {
    const connections: Array<{ close: ReturnType<typeof vi.fn>; call: ReturnType<typeof vi.fn> }> = [];
    const connect = vi.fn(async () => {
      const made = { close: vi.fn(async () => undefined), call: vi.fn(call) };
      connections.push(made);
      return { tools: [searchTool], call: made.call, close: made.close } as McpConnection;
    });
    return { connect, connections };
  }

  it("connects once and reuses the connection for every search", async () => {
    const { connect, connections } = fakeConnect(async (_name, args) => JSON.stringify({ memories: [{ url: `https://a.com/${(args as { source: string }).source}` }] }));
    const vmem = createVmemSearch(() => config(), connect);
    vmem.refresh();
    const first = await vmem.search("a");
    await vmem.search("b");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connections[0]?.call).toHaveBeenCalledTimes(4);
    expect(parseHistoryHits(first, "a.com").map((hit) => hit.url)).toEqual(["https://a.com/browsing-history", "https://a.com/bookmark"]);
  });

  it("does not connect while signed out, and closes when the connector goes", async () => {
    const { connect, connections } = fakeConnect();
    let current: McpServerConfig | undefined = config({ oauthSignedIn: false });
    const vmem = createVmemSearch(() => current, connect);
    vmem.refresh();
    await expect(vmem.search("a")).rejects.toThrow(/not signed in/);
    expect(connect).not.toHaveBeenCalled();
    current = config();
    vmem.refresh();
    await vmem.search("a");
    current = undefined;
    vmem.refresh();
    await vi.waitFor(() => expect(connections[0]?.close).toHaveBeenCalled());
    await expect(vmem.search("a")).rejects.toThrow(/not connected/);
  });

  it("keeps the connection after a timeout, and reconnects after another failure", async () => {
    let failure = new Error("Tool memory_search timed out after 1 s");
    const { connect, connections } = fakeConnect(async () => {
      throw failure;
    });
    const vmem = createVmemSearch(() => config(), connect);
    await expect(vmem.search("a")).rejects.toThrow(/timed out/);
    await expect(vmem.search("a")).rejects.toThrow(/timed out/);
    expect(connect).toHaveBeenCalledTimes(1);
    failure = new Error("socket closed");
    await expect(vmem.search("a")).rejects.toThrow(/socket closed/);
    await expect(vmem.search("a")).rejects.toThrow(/socket closed/);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(connections[0]?.close).toHaveBeenCalled();
  });

  it("tries again after a failed connect", async () => {
    const connect = vi.fn().mockRejectedValueOnce(new Error("Connecting timed out")).mockResolvedValue({ tools: [searchTool], call: async () => "{}", close: async () => undefined });
    const vmem = createVmemSearch(() => config(), connect);
    await expect(vmem.search("a")).rejects.toThrow(/timed out/);
    await expect(vmem.search("a")).resolves.toEqual({ results: [] });
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
