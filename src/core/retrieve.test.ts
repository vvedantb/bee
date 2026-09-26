import { describe, expect, it } from "vitest";
import { SEED_NOTES, chunkNote, chunkNotes } from "./notes";
import { retrieve, tokenize, transcriptQuery } from "./retrieve";

const snippets = chunkNotes(SEED_NOTES);

describe("chunkNote", () => {
  it("splits on ## sections and prefixes the note title", () => {
    const chunks = chunkNote({ name: "a.md", content: "# Alpha\n\nintro\n\n## One\nfirst\n\n## Two\nsecond" });
    expect(chunks.map((chunk) => chunk.title)).toEqual(["Alpha", "Alpha › One", "Alpha › Two"]);
    expect(chunks.map((chunk) => chunk.id)).toEqual(["a.md#0", "a.md#1", "a.md#2"]);
  });

  it("falls back to the file name and drops empty sections", () => {
    const chunks = chunkNote({ name: "plain.md", content: "## Empty\n\n## Full\ntext" });
    expect(chunks).toEqual([{ id: "plain.md#2", title: "plain › Full", text: "text" }]);
  });
});

describe("tokenize", () => {
  it("lowercases, drops stopwords and strips simple plurals", () => {
    expect(tokenize("The Discounts for ACME renewals")).toEqual(["discount", "acme", "renewal"]);
  });
});

describe("retrieve", () => {
  it("ranks the pricing note first for a discount question", () => {
    const results = retrieve("Acme want a bigger discount on the renewal", snippets);
    expect(results[0]?.snippet.title).toBe("Acme renewal › Pricing");
  });

  it("finds the SSO date for a roadmap question", () => {
    const results = retrieve("when does SSO ship", snippets);
    expect(results[0]?.snippet.title).toBe("Q4 product roadmap › Dates");
  });

  it("returns nothing for stopword-only or unrelated queries", () => {
    expect(retrieve("the and of", snippets)).toEqual([]);
    expect(retrieve("xylophone", snippets)).toEqual([]);
  });

  it("respects the limit and sorts by score", () => {
    const results = retrieve("acme discount support sso salary", snippets, 3);
    expect(results).toHaveLength(3);
    const scores = results.map((result) => result.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });
});

describe("transcriptQuery", () => {
  it("uses the last lines and weights the latest", () => {
    expect(transcriptQuery(["a", "b", "c", "d"], 2)).toBe("c d d");
    expect(transcriptQuery([])).toBe("");
  });
});
