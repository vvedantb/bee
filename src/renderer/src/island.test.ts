import { describe, expect, it } from "vitest";
import {
  ISLAND_MIN_OPEN_MS,
  READ_WORDS_PER_SECOND,
  activityLabel,
  displayTip,
  islandPhase,
  mcpErrorNote,
  islandShowsBody,
  islandClick,
  islandOpenMs,
  shouldAutoCollapse,
  shouldShowResponse,
  timingsLabel,
  timingsTitle,
} from "./island";

const empty = { tips: [], guideError: null, dismissed: false };

describe("displayTip", () => {
  it("strips note and numbered citation markers", () => {
    expect(displayTip("Offer 15% off, as in the Acme pricing note [n1].")).toBe("Offer 15% off, as in the Acme pricing note.");
    expect(displayTip("Per the docs [N12] and the blog [3][12], run it locally.")).toBe("Per the docs and the blog, run it locally.");
    expect(displayTip("[1] Start with the renewal date.")).toBe("Start with the renewal date.");
  });

  it("collapses leftover spaces and keeps other brackets", () => {
    expect(displayTip("Quote  the [n2]  two-year term.")).toBe("Quote the two-year term.");
    expect(displayTip("Use [web] results and [note 1] as written.")).toBe("Use [web] results and [note 1] as written.");
    expect(displayTip("SSO ships in Q4 (roadmap).")).toBe("SSO ships in Q4 (roadmap).");
  });
});

describe("mcpErrorNote", () => {
  it("is null without errors", () => {
    expect(mcpErrorNote(undefined)).toBeNull();
    expect(mcpErrorNote([])).toBeNull();
  });

  it("asks for a new sign-in when the error is about signing in, else shows a short reason, on one line", () => {
    expect(mcpErrorNote([{ server: "Eva", error: "Sign in from the Connectors tab" }])).toBe("Eva unavailable: sign in again from Connectors");
    expect(mcpErrorNote([{ server: "Eva", error: "not signed in" }])).toBe("Eva unavailable: sign in again from Connectors");
    expect(mcpErrorNote([{ server: "Eva", error: "at least one redirect_uri is required" }])).toBe("Eva unavailable: sign in again from Connectors");
    const note = mcpErrorNote([
      { server: "vmem", error: "Connecting timed out\nafter 10 s" },
      { server: "Big", error: "y".repeat(200) },
    ]);
    expect(note).toBe(`vmem unavailable: Connecting timed out after 10 s; Big unavailable: ${"y".repeat(59)}…`);
  });
});

describe("activityLabel", () => {
  it("names web search", () => {
    expect(activityLabel("web_search")).toBe("The AI is searching the web…");
  });

  it("calls every file tool Reading notes", () => {
    for (const tool of ["read_file", "list_dir", "search_files"]) expect(activityLabel(tool)).toBe("Reading notes");
  });

  it("names the note writer", () => {
    expect(activityLabel("append_note")).toBe("Writing a note");
    expect(activityLabel("open_app")).toBe("Opening the app…");
    expect(activityLabel("focus_window")).toBe("Switching windows…");
    expect(activityLabel("open_url")).toBe("Opening the link…");
    expect(activityLabel("look_at_screen")).toBe("Looking at your screen…");
  });

  it("names every computer-use tool, so none reads as Thinking…", async () => {
    const { COMPUTER_TOOL_NAMES } = await import("../../core/computer-tools");
    for (const tool of [...COMPUTER_TOOL_NAMES, "use_computer"]) expect(activityLabel(tool), tool).not.toBe("Thinking…");
    expect(activityLabel("click")).toBe("Clicking…");
    expect(activityLabel("type_text")).toBe("Typing…");
    expect(activityLabel("use_computer")).toBe("Using your computer…");
  });

  it("names looking at an app and acting at a point in short words", () => {
    expect(activityLabel("look")).toBe("Looking at the app…");
    expect(activityLabel("click_at")).toBe("Clicking…");
    expect(activityLabel("right_click")).toBe("Clicking…");
    expect(activityLabel("double_click")).toBe("Clicking…");
    expect(activityLabel("drag_at")).toBe("Dragging…");
    expect(activityLabel("wheel_at")).toBe("Scrolling…");
    expect(activityLabel("paste_text")).toBe("Pasting…");
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
    expect(calls.map((call) => activityLabel(call.toolName))).toEqual(["The AI is searching the web…", "Reading notes", "Writing a note"]);
  });
});

describe("shouldShowResponse", () => {
  it("is false when there is nothing to show", () => {
    expect(shouldShowResponse(empty)).toBe(false);
  });

  it("is true for tips or a guide error", () => {
    expect(shouldShowResponse({ ...empty, tips: ["Say yes"] })).toBe(true);
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
    // An error alone is stale detail, not an answer to keep on screen.
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
