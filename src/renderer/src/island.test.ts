import { describe, expect, it } from "vitest";
import { ISLAND_IDLE_MS, activityLabel, islandPhase, shouldAutoCollapse, shouldShowResponse } from "./island";

const empty = { tips: [], sources: [], guideError: null, dismissed: false };
const source = { title: "Example", url: "https://example.com/" };

describe("activityLabel", () => {
  it("names web search", () => {
    expect(activityLabel("web_search")).toBe("Searching the web");
  });

  it("calls every file tool Reading notes", () => {
    for (const tool of ["read_file", "list_dir", "search_files"]) expect(activityLabel(tool)).toBe("Reading notes");
  });

  it("names the note writer", () => {
    expect(activityLabel("append_note")).toBe("Writing a note");
  });

  it("falls back to Thinking… for unknown, missing or inherited names", () => {
    expect(activityLabel("calendar_lookup")).toBe("Thinking…");
    expect(activityLabel(null)).toBe("Thinking…");
    expect(activityLabel(undefined)).toBe("Thinking…");
    expect(activityLabel("")).toBe("Thinking…");
    expect(activityLabel("toString")).toBe("Thinking…");
  });

  it("names the MCP server for namespaced tools", () => {
    expect(activityLabel("vmem__search")).toBe("Using vmem…");
    expect(activityLabel("eva__foo")).toBe("Using eva…");
    expect(activityLabel("my-server__do__it")).toBe("Using my-server…");
  });

  it("does not treat a bare or trailing double underscore as a server", () => {
    expect(activityLabel("__x")).toBe("Thinking…");
    expect(activityLabel("vmem__")).toBe("Thinking…");
  });

  it("maps the tool names Luna's step callback reports", () => {
    const calls = [{ toolName: "web_search" }, { toolName: "read_file" }, { toolName: "append_note" }];
    expect(calls.map((call) => activityLabel(call.toolName))).toEqual(["Searching the web", "Reading notes", "Writing a note"]);
  });
});

describe("shouldShowResponse", () => {
  it("is false when there is nothing to show", () => {
    expect(shouldShowResponse(empty)).toBe(false);
  });

  it("is true for tips, sources only, or a guide error", () => {
    expect(shouldShowResponse({ ...empty, tips: ["Say yes"] })).toBe(true);
    expect(shouldShowResponse({ ...empty, sources: [source] })).toBe(true);
    expect(shouldShowResponse({ ...empty, guideError: "Luna guidance failed: timeout" })).toBe(true);
  });

  it("is false once dismissed", () => {
    expect(shouldShowResponse({ ...empty, tips: ["Say yes"], dismissed: true })).toBe(false);
  });

  it("is true for link chips alone, unless dismissed or none", () => {
    expect(shouldShowResponse({ ...empty, chipCount: 1 })).toBe(true);
    expect(shouldShowResponse({ ...empty, chipCount: 0 })).toBe(false);
    expect(shouldShowResponse({ ...empty, chipCount: 2, dismissed: true })).toBe(false);
  });
});

describe("islandPhase", () => {
  it("is idle with no result and not busy", () => {
    expect(islandPhase({ ...empty, busy: false })).toBe("idle");
  });

  it("is thinking while busy, even over an old answer", () => {
    expect(islandPhase({ ...empty, busy: true })).toBe("thinking");
    expect(islandPhase({ ...empty, tips: ["Old tip"], busy: true })).toBe("thinking");
  });

  it("is expanded with tips", () => {
    expect(islandPhase({ ...empty, tips: ["Say yes"], busy: false })).toBe("expanded");
  });

  it("is expanded with sources only", () => {
    expect(islandPhase({ ...empty, sources: [source], busy: false })).toBe("expanded");
  });

  it("is expanded with link chips only", () => {
    expect(islandPhase({ ...empty, chipCount: 1, busy: false })).toBe("expanded");
    expect(islandPhase({ ...empty, chipCount: 1, busy: true })).toBe("thinking");
  });

  it("is idle once dismissed", () => {
    expect(islandPhase({ ...empty, tips: ["Say yes"], dismissed: true, busy: false })).toBe("idle");
  });
});

describe("shouldAutoCollapse", () => {
  const base = { phase: "expanded" as const, hovered: false, lastActivityAt: 1_000 };

  it("collapses after the idle time", () => {
    expect(shouldAutoCollapse({ ...base, now: 1_000 + ISLAND_IDLE_MS })).toBe(true);
  });

  it("waits until the idle time has passed", () => {
    expect(shouldAutoCollapse({ ...base, now: 1_000 + ISLAND_IDLE_MS - 1 })).toBe(false);
  });

  it("does not collapse while thinking", () => {
    expect(shouldAutoCollapse({ ...base, phase: "thinking", now: 1_000 + ISLAND_IDLE_MS * 5 })).toBe(false);
  });

  it("does not collapse while the pointer is on the island", () => {
    expect(shouldAutoCollapse({ ...base, hovered: true, now: 1_000 + ISLAND_IDLE_MS * 5 })).toBe(false);
  });

  it("has nothing to collapse when idle", () => {
    expect(shouldAutoCollapse({ ...base, phase: "idle", now: 1_000 + ISLAND_IDLE_MS })).toBe(false);
  });

  it("keeps the delay between 8 and 12 s", () => {
    expect(ISLAND_IDLE_MS).toBeGreaterThanOrEqual(8_000);
    expect(ISLAND_IDLE_MS).toBeLessThanOrEqual(12_000);
  });

  it("dismiss closes the body, and a new result opens it again", () => {
    const result = { ...empty, tips: ["Say yes"] };
    expect(islandPhase({ ...result, dismissed: true, busy: false })).toBe("idle");
    // The store clears dismissed when the next result arrives.
    expect(islandPhase({ ...result, dismissed: false, busy: false })).toBe("expanded");
    // The idle clock restarts with that result.
    const arrivedAt = 50_000;
    expect(shouldAutoCollapse({ phase: "expanded", hovered: false, lastActivityAt: arrivedAt, now: arrivedAt + 1_000 })).toBe(false);
  });
});
