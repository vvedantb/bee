import { describe, expect, it } from "vitest";
import {
  FOLLOW_SLACK_PX,
  ISLAND_MIN_OPEN_MS,
  READ_WORDS_PER_SECOND,
  activityLabel,
  islandPhase,
  keepFollowing,
  mcpErrorNote,
  islandShowsBody,
  islandClick,
  islandOpenMs,
  nearBottom,
  shouldAutoCollapse,
  shouldShowResponse,
  timingsLabel,
  timingsTitle,
} from "./island";

const empty = { tips: [], sources: [], guideError: null, dismissed: false };
const source = { title: "Example", url: "https://example.com/" };

describe("mcpErrorNote", () => {
  it("is null without errors", () => {
    expect(mcpErrorNote(undefined)).toBeNull();
    expect(mcpErrorNote([])).toBeNull();
  });

  it("asks for a new sign-in when the error is about signing in, else shows a short reason, on one line", () => {
    expect(mcpErrorNote([{ server: "Eva", error: "Sign in from the Connectors tab" }])).toBe("Eva unavailable: sign in again from Connectors");
    expect(mcpErrorNote([{ server: "Eva", error: "not signed in" }])).toBe("Eva unavailable: sign in again from Connectors");
    const note = mcpErrorNote([
      { server: "vmem", error: "Connecting timed out\nafter 10 s" },
      { server: "Big", error: "y".repeat(200) },
    ]);
    expect(note).toBe(`vmem unavailable: Connecting timed out after 10 s; Big unavailable: ${"y".repeat(59)}…`);
  });
});

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
    expect(shouldShowResponse({ ...empty, guideError: "AI guidance failed: timeout" })).toBe(true);
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

describe("islandPhase revising", () => {
  it("reads revising while busy with a newer line over kept tips", () => {
    const args = { ...empty, tips: ["Kept tip"], busy: true, revising: true };
    expect(islandPhase(args)).toBe("revising");
    expect(islandShowsBody(args)).toBe(true);
    expect(islandPhase({ ...args, revising: false })).toBe("thinking");
    expect(islandPhase({ ...args, busy: false })).toBe("expanded");
  });
});

describe("islandShowsBody", () => {
  it("shows link chips while busy, with the pill still thinking", () => {
    const args = { ...empty, chipCount: 2, busy: true };
    expect(islandShowsBody(args)).toBe(true);
    expect(islandPhase(args)).toBe("thinking");
  });

  it("stays closed while busy with nothing to show", () => {
    expect(islandShowsBody({ ...empty, busy: true })).toBe(false);
    // Sources or an error alone are stale detail, not an answer to keep on screen.
    expect(islandShowsBody({ ...empty, sources: [source], busy: true })).toBe(false);
    expect(islandShowsBody({ ...empty, guideError: "AI guidance failed: x", busy: true })).toBe(false);
  });

  it("keeps the body open while busy when tips exist, with the pill still thinking", () => {
    const args = { ...empty, tips: ["Old tip"], busy: true };
    expect(islandShowsBody(args)).toBe(true);
    expect(islandPhase(args)).toBe("thinking");
    expect(islandShowsBody({ ...args, chipCount: 1 })).toBe(true);
  });

  it("closes a busy body the user dismissed, even with tips", () => {
    expect(islandShowsBody({ ...empty, tips: ["Old tip"], dismissed: true, busy: true })).toBe(false);
    expect(islandShowsBody({ ...empty, tips: ["Old tip"], chipCount: 1, dismissed: true, busy: true })).toBe(false);
  });

  it("stays closed while busy when the chips were dismissed", () => {
    expect(islandShowsBody({ ...empty, chipCount: 1, dismissed: true, busy: true })).toBe(false);
  });

  it("follows shouldShowResponse when not busy", () => {
    expect(islandShowsBody({ ...empty, busy: false })).toBe(false);
    expect(islandShowsBody({ ...empty, tips: ["Say yes"], busy: false })).toBe(true);
    expect(islandShowsBody({ ...empty, chipCount: 1, busy: false })).toBe(true);
    expect(islandShowsBody({ ...empty, tips: ["Say yes"], dismissed: true, busy: false })).toBe(false);
  });
});

describe("islandOpenMs", () => {
  it("is at least 30 s, plus reading time at 3.3 words a second", () => {
    expect(ISLAND_MIN_OPEN_MS).toBe(30_000);
    expect(READ_WORDS_PER_SECOND).toBe(3.3);
    expect(islandOpenMs("")).toBe(30_000);
    expect(islandOpenMs("  Say   yes ")).toBe(30_000 + Math.round((2 / 3.3) * 1000));
  });

  it("grows with the answer: 66 words add 20 s", () => {
    expect(islandOpenMs(Array.from({ length: 66 }, () => "word").join(" "))).toBe(50_000);
  });
});

describe("shouldAutoCollapse", () => {
  const openMs = islandOpenMs("Offer 15% off for a two-year term.");
  const base = { phase: "expanded" as const, hovered: false, fullText: false, lastActivityAt: 1_000, openMs };

  it("folds the body to the pill once the reading time has passed", () => {
    expect(shouldAutoCollapse({ ...base, now: 1_000 + openMs })).toBe(true);
  });

  it("never folds within 30 s, the old 10 s included", () => {
    expect(shouldAutoCollapse({ ...base, now: 1_000 + 10_000 })).toBe(false);
    expect(shouldAutoCollapse({ ...base, now: 1_000 + openMs - 1 })).toBe(false);
  });

  it("does not collapse while thinking", () => {
    expect(shouldAutoCollapse({ ...base, phase: "thinking", now: 1_000 + openMs * 5 })).toBe(false);
  });

  it("does not collapse while the pointer is on the island", () => {
    expect(shouldAutoCollapse({ ...base, hovered: true, now: 1_000 + openMs * 5 })).toBe(false);
  });

  it("never collapses an answer the user opened in full", () => {
    expect(shouldAutoCollapse({ ...base, fullText: true, now: 1_000 + openMs * 100 })).toBe(false);
  });

  it("has nothing to collapse when idle", () => {
    expect(shouldAutoCollapse({ ...base, phase: "idle", now: 1_000 + openMs })).toBe(false);
  });

  it("dismiss closes the body, and a new result (or a scroll) restarts the clock", () => {
    const result = { ...empty, tips: ["Say yes"] };
    expect(islandPhase({ ...result, dismissed: true, busy: false })).toBe("idle");
    // The store clears dismissed when the next result arrives.
    expect(islandPhase({ ...result, dismissed: false, busy: false })).toBe("expanded");
    const arrivedAt = 50_000;
    expect(shouldAutoCollapse({ ...base, lastActivityAt: arrivedAt, now: arrivedAt + openMs - 1 })).toBe(false);
  });
});

describe("islandClick", () => {
  const folded = { panelOpen: false, bodyShown: false, hasResponse: true };

  it("opens the one-line answer in full in the island, never the panel", () => {
    expect(islandClick("status", folded)).toBe("full-text");
  });

  it("does nothing for status text that is not an answer, or an answer already open", () => {
    expect(islandClick("status", { ...folded, hasResponse: false })).toBeNull();
    expect(islandClick("status", { ...folded, bodyShown: true })).toBeNull();
    expect(islandClick("status", { ...folded, panelOpen: true })).toBeNull();
  });

  it("leaves the panel to the chevron, which still toggles it", () => {
    expect(islandClick("chevron", folded)).toBe("open-panel");
    expect(islandClick("chevron", { ...folded, panelOpen: true })).toBe("close-panel");
    expect(islandClick("chevron", { ...folded, bodyShown: true })).toBe("open-panel");
  });
});

describe("timingsLabel", () => {
  const timings = { retrieve: 10, rank: 900, guide: 2000, mcp: 400 };

  it("is wall time: retrieval, then the slower of Jev and MCP plus Luna", () => {
    expect(timingsLabel(timings)).toBe("2410 ms");
    expect(timingsLabel({ ...timings, rank: 5000 })).toBe("5010 ms");
  });

  it("shows MCP on its own, not inside Luna's time", () => {
    const title = timingsTitle(timings);
    expect(title).toContain("MCP 400 ms");
    expect(title).toContain("AI 2000 ms");
    expect(title).toContain("Jev 900 ms");
  });
});

describe("meeting card", () => {
  it("opens the body on its own, until the user closes it", () => {
    expect(shouldShowResponse({ ...empty, cardLines: 2 })).toBe(true);
    expect(shouldShowResponse({ ...empty, cardLines: 0 })).toBe(false);
    expect(shouldShowResponse({ ...empty, cardLines: 2, dismissed: true })).toBe(false);
    expect(islandPhase({ ...empty, cardLines: 1, busy: false })).toBe("expanded");
  });

  it("stays on screen while Luna thinks, unless dismissed", () => {
    expect(islandShowsBody({ ...empty, cardLines: 2, busy: true })).toBe(true);
    expect(islandShowsBody({ ...empty, cardLines: 2, busy: true, dismissed: true })).toBe(false);
  });
});

// A 300 px tall body over 1000 px of tips: the bottom is at scrollTop 700.
const at = (scrollTop: number) => ({ scrollTop, scrollHeight: 1000, clientHeight: 300 });

describe("nearBottom", () => {
  it("counts the last FOLLOW_SLACK_PX as the bottom", () => {
    expect(nearBottom(at(700))).toBe(true);
    expect(nearBottom(at(700 - FOLLOW_SLACK_PX))).toBe(true);
    expect(nearBottom(at(700 - FOLLOW_SLACK_PX - 1))).toBe(false);
    expect(nearBottom(at(0))).toBe(false);
  });

  it("is at the bottom when the content fits", () => {
    expect(nearBottom({ scrollTop: 0, scrollHeight: 200, clientHeight: 300 })).toBe(true);
  });
});

describe("keepFollowing", () => {
  it("pauses when the user scrolls up away from the bottom", () => {
    expect(keepFollowing(true, 700, at(500))).toBe(false);
  });

  it("keeps following while Bee's smooth scroll moves down towards the bottom", () => {
    expect(keepFollowing(true, 300, at(450))).toBe(true);
  });

  it("stays paused while the user scrolls down short of the bottom, and resumes near it", () => {
    expect(keepFollowing(false, 300, at(450))).toBe(false);
    expect(keepFollowing(false, 450, at(690))).toBe(true);
  });

  it("keeps following when shorter content pulls the scroll position up to the new bottom", () => {
    expect(keepFollowing(true, 700, { scrollTop: 400, scrollHeight: 700, clientHeight: 300 })).toBe(true);
  });
});
