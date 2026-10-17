import { tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { lunaTools, sourcesFromGenerateResult } from "./tools";

describe("lunaTools", () => {
  it("offers only web_search without a notes folder", () => {
    expect(Object.keys(lunaTools())).toEqual(["web_search"]);
    expect(Object.keys(lunaTools({ extraRoots: ["/x"] }))).toEqual(["web_search"]);
  });

  it("adds the file tools when a notes folder is passed", () => {
    expect(Object.keys(lunaTools({ notesDir: "/notes" }))).toEqual([
      "web_search",
      "list_dir",
      "search_files",
      "read_file",
      "append_note",
    ]);
    expect(Object.keys(lunaTools({ notesDir: "/notes", extraRoots: ["/more"] }))).toHaveLength(5);
  });
});

describe("lunaTools extra (MCP)", () => {
  const ping = tool({ description: "ping", inputSchema: z.object({}), execute: async () => "pong" });

  it("adds namespaced extra tools with or without a notes folder", () => {
    expect(Object.keys(lunaTools({ extra: { vmem__ping: ping } })).sort()).toEqual(["vmem__ping", "web_search"]);
    expect(Object.keys(lunaTools({ notesDir: "/notes", extra: { vmem__ping: ping } }))).toHaveLength(6);
  });

  it("never lets an extra tool replace a built-in", () => {
    expect(lunaTools({ extra: { web_search: ping } }).web_search).not.toBe(ping);
  });
});

describe("sourcesFromGenerateResult", () => {
  it("reads url sources and falls back to the hostname for a missing title", () => {
    const sources = sourcesFromGenerateResult({
      sources: [
        { sourceType: "url", id: "1", url: "https://www.gov.uk/government/ministers/prime-minister", title: "Prime Minister" },
        { sourceType: "url", id: "2", url: "https://example.com/a" },
      ],
    });
    expect(sources).toEqual([
      { title: "Prime Minister", url: "https://www.gov.uk/government/ministers/prime-minister" },
      { title: "example.com", url: "https://example.com/a" },
    ]);
  });

  it("truncates a 400-char title to 300 chars", () => {
    const sources = sourcesFromGenerateResult({
      sources: [{ sourceType: "url", id: "1", url: "https://example.com/a", title: "t".repeat(400) }],
    });
    expect(sources[0]?.title).toHaveLength(300);
  });

  it("drops a source whose url is longer than 2000 chars", () => {
    const sources = sourcesFromGenerateResult({
      sources: [
        { sourceType: "url", id: "1", url: `https://example.com/${"a".repeat(2500)}` },
        { sourceType: "url", id: "2", url: "https://example.com/ok" },
      ],
    });
    expect(sources).toEqual([{ title: "example.com", url: "https://example.com/ok" }]);
  });

  it("uses toolResults output.sources when result.sources is empty", () => {
    const sources = sourcesFromGenerateResult({
      sources: [],
      toolResults: [{ output: { sources: [{ type: "url", url: "https://bbc.co.uk/news" }] } }],
    });
    expect(sources).toEqual([{ title: "bbc.co.uk", url: "https://bbc.co.uk/news" }]);
  });

  it("prefers result.sources over toolResults", () => {
    const sources = sourcesFromGenerateResult({
      sources: [{ sourceType: "url", id: "1", url: "https://a.com/", title: "A" }],
      toolResults: [{ output: { sources: [{ type: "url", url: "https://b.com/" }] } }],
    });
    expect(sources.map((source) => source.url)).toEqual(["https://a.com/"]);
  });

  it("drops duplicates, non-https, empty and invalid URLs, and document sources", () => {
    const sources = sourcesFromGenerateResult({
      sources: [
        { sourceType: "url", id: "1", url: "https://a.com/x", title: "A" },
        { sourceType: "url", id: "2", url: "https://a.com/x", title: "A again" },
        { sourceType: "url", id: "3", url: "http://insecure.com" },
        { sourceType: "url", id: "4", url: "" },
        { sourceType: "url", id: "5", url: "not a url" },
        { sourceType: "document", id: "6", title: "Doc", mediaType: "text/plain" },
      ],
    });
    expect(sources).toEqual([{ title: "A", url: "https://a.com/x" }]);
  });

  it("caps the list at five", () => {
    const many = Array.from({ length: 9 }, (_, index) => ({ sourceType: "url", id: `${index}`, url: `https://site${index}.com/` }));
    expect(sourcesFromGenerateResult({ sources: many })).toHaveLength(5);
  });

  it("returns nothing for an empty result", () => {
    expect(sourcesFromGenerateResult({})).toEqual([]);
  });
});
