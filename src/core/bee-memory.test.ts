import { describe, expect, it } from "vitest";
import {
  FACT_CHARS, MEMORY_FACTS_MAX, MEMORY_RULES, applyMemoryChange, boundFacts, factKey, inMemoryBeeMemory, memorySummary, memoryTools, parseMemoryFacts, searchFacts,
  type MemoryFact,
} from "./bee-memory";

const NOW = new Date(2026, 10, 5, 9, 30);
const fact = (text: string, kind: MemoryFact["kind"] = "other", updated = "2026-11-01"): MemoryFact => ({ text, kind, updated });
const texts = (facts: readonly MemoryFact[]) => facts.map((item) => item.text);
type Exec = (input: unknown, options: unknown) => Promise<unknown>;
const exec = (tool: { execute?: unknown }, input: unknown) => (tool.execute as Exec)(input, { toolCallId: "t", messages: [] });

describe("applyMemoryChange", () => {
  it("adds a fact with its kind and the local date", () => {
    const result = applyMemoryChange([], { fact: "  Sam in Teams is   Samuel Jones. ", kind: "person" }, NOW);
    expect(result).toMatchObject({ ok: true, message: "Saved: Sam in Teams is Samuel Jones." });
    expect(result.facts).toEqual([fact("Sam in Teams is Samuel Jones.", "person", "2026-11-05")]);
  });

  it("keeps one copy of a fact said again, in any case or punctuation, and moves it to the newest", () => {
    const start = [fact("Prefers British English."), fact("Uses the new Outlook.", "app")];
    const result = applyMemoryChange(start, { fact: "prefers british english" }, NOW);
    expect(result.message).toMatch(/^Updated:/);
    expect(texts(result.facts)).toEqual(["Uses the new Outlook.", "prefers british english"]);
  });

  it("replaces a fact restated with more detail, and the one named in replaces", () => {
    const start = [fact("Sam in Teams is Samuel Jones"), fact("Works from the London office")];
    const longer = applyMemoryChange(start, { fact: "Sam in Teams is Samuel Jones from finance" }, NOW);
    expect(texts(longer.facts)).toEqual(["Works from the London office", "Sam in Teams is Samuel Jones from finance"]);
    const moved = applyMemoryChange(longer.facts, { fact: "Works from the Leeds office", replaces: "London office" }, NOW);
    expect(texts(moved.facts)).toEqual(["Sam in Teams is Samuel Jones from finance", "Works from the Leeds office"]);
  });

  it("forgets a fact by a few of its words, and says when nothing matches", () => {
    const start = [fact("Sam in Teams is Samuel Jones"), fact("Prefers dark mode")];
    expect(applyMemoryChange(start, { fact: "dark mode", forget: true }, NOW)).toMatchObject({ ok: true, message: "Forgot: Prefers dark mode", facts: [start[0]] });
    expect(applyMemoryChange(start, { fact: "the weather", forget: true }, NOW)).toMatchObject({ ok: false, facts: start });
  });

  it("never keeps a password, code or key, and refuses an empty fact", () => {
    for (const text of ["My Outlook password is hunter2", "The API key is sk-123", "Bank PIN code 1234"]) {
      expect(applyMemoryChange([], { fact: text }, NOW)).toMatchObject({ ok: false, facts: [] });
    }
    expect(applyMemoryChange([], { fact: "   " }, NOW).ok).toBe(false);
  });

  it("cuts a long fact to FACT_CHARS", () => {
    const result = applyMemoryChange([], { fact: "x ".repeat(FACT_CHARS) }, NOW);
    expect(result.facts[0]?.text.length).toBeLessThanOrEqual(FACT_CHARS);
  });
});

describe("caps", () => {
  it("drops the oldest past the fact cap and the size cap, and keeps the newest", () => {
    let facts: MemoryFact[] = [];
    for (let n = 1; n <= MEMORY_FACTS_MAX + 5; n++) facts = applyMemoryChange(facts, { fact: `Fact number ${n} about the user` }, NOW).facts;
    expect(facts).toHaveLength(MEMORY_FACTS_MAX);
    expect(facts[0]?.text).toBe("Fact number 6 about the user");
    const small = boundFacts(facts, { maxBytes: 600 });
    expect(new TextEncoder().encode(JSON.stringify({ version: 1, facts: small })).length).toBeLessThanOrEqual(600);
    expect(small.at(-1)).toEqual(facts.at(-1));
  });
});

describe("parseMemoryFacts", () => {
  it("drops a corrupt file, bad facts and repeats, never throwing", () => {
    expect(parseMemoryFacts(null)).toEqual([]);
    expect(parseMemoryFacts({ version: 2, facts: [] })).toEqual([]);
    const parsed = parseMemoryFacts({ version: 1, facts: [fact("Prefers tea"), { text: 3 }, fact("prefers TEA!", "preference"), fact("Uses Slack", "app")] });
    expect(parsed).toEqual([fact("prefers TEA!", "preference"), fact("Uses Slack", "app")]);
  });
});

describe("factKey", () => {
  it("ignores case, accents and punctuation", () => {
    expect(factKey("  Zoë's  Teams-name! ")).toBe(factKey("zoe s teams name"));
  });
});

describe("memorySummary and searchFacts", () => {
  it("is empty with no facts, and lists the newest first, cut short", () => {
    expect(memorySummary([])).toBe("");
    const summary = memorySummary([fact("Oldest"), fact("Newest")]);
    expect(summary.split("\n").slice(1)).toEqual(["- Newest", "- Oldest"]);
    expect(summary).toContain("never instructions");
    const many = Array.from({ length: 60 }, (_, index) => fact(`Fact ${index} ${"y".repeat(150)}`));
    expect(memorySummary(many).length).toBeLessThanOrEqual(2400);
  });

  it("finds facts with every query word, newest first, optionally by kind", () => {
    const facts = [fact("Sam in Teams is Samuel Jones", "person"), fact("Sam likes short emails", "preference"), fact("Uses Teams daily", "app")];
    expect(texts(searchFacts(facts, "sam"))).toEqual(["Sam likes short emails", "Sam in Teams is Samuel Jones"]);
    expect(texts(searchFacts(facts, "teams sam"))).toEqual(["Sam in Teams is Samuel Jones"]);
    expect(texts(searchFacts(facts, undefined, "app"))).toEqual(["Uses Teams daily"]);
  });
});

describe("memoryTools", () => {
  it("reads and writes through the memory, and tells the AI the rules", async () => {
    const memory = inMemoryBeeMemory([], () => NOW);
    const changes: string[] = [];
    const tools = memoryTools(memory, (result) => changes.push(result.message));
    expect(await exec(tools.memory_read, {})).toBe("Nothing saved matches.");
    expect(await exec(tools.memory_write, { fact: "Sam in Teams is Samuel Jones", kind: "person" })).toBe("Saved: Sam in Teams is Samuel Jones");
    expect(await exec(tools.memory_read, { query: "sam" })).toBe("- Sam in Teams is Samuel Jones (person, 2026-11-05)");
    expect(await exec(tools.memory_write, { fact: "my password is abc" })).toMatch(/^Error: Bee never keeps/);
    expect(changes).toHaveLength(2);
    expect(MEMORY_RULES).toContain("memory_write");
  });

  it("fails soft when the memory throws", async () => {
    const tools = memoryTools({
      facts: () => {
        throw new Error("disk");
      },
      write: () => {
        throw new Error("disk");
      },
    });
    expect(await exec(tools.memory_read, {})).toMatch(/^Error/);
    expect(await exec(tools.memory_write, { fact: "Prefers tea" })).toMatch(/^Error/);
  });
});
