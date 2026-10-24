import { describe, expect, it } from "vitest";
import type { PipelineResult } from "../../shared/ipc";
import { statusClick } from "./island-click";
import { notchLine, type NotchStatusKind } from "./notch";

const answered: PipelineResult = {
  notes: [],
  rankSource: "fallback",
  rankError: null,
  tips: ["Ask about the Q3 budget"],
  sources: [],
  guideError: null,
  timingsMs: { retrieve: 0, rank: 0, guide: 0, mcp: 0, lunaFirstToken: null, lunaTotal: 0 },
};

const ready: Parameters<typeof notchLine>[0] = {
  busy: false,
  revising: false,
  tools: [],
  question: false,
  heard: false,
  mic: { on: false, level: 0, error: null },
  result: null,
  settings: { gatewayKeySource: "saved", meetingMode: false },
  session: { lines: [] },
};

const closed = { panelOpen: false, bodyShown: false, answerFolded: false };

/** What a click on the pill's status opens for this state, with the panel and body closed. */
function clickFor(state: Parameters<typeof notchLine>[0], signedIn: boolean | undefined = true) {
  return statusClick({ ...closed, kind: notchLine(state, signedIn).kind, answerFolded: state.result !== null });
}

describe("statusClick", () => {
  it("opens a folded answer in full in the island", () => {
    expect(notchLine({ ...ready, result: answered }, true)).toEqual({ kind: "answer", text: "Ask about the Q3 budget" });
    expect(clickFor({ ...ready, result: answered })).toBe("full-text");
  });

  it("does nothing for an answer already open in the body or under the open panel", () => {
    expect(statusClick({ kind: "answer", panelOpen: false, bodyShown: true, answerFolded: true })).toBeNull();
    expect(statusClick({ kind: "answer", panelOpen: true, bodyShown: false, answerFolded: true })).toBeNull();
  });

  it("sends the missing AI Gateway key status to Settings, where the key field is first, even with the panel open", () => {
    const noKey: Parameters<typeof notchLine>[0] = { ...ready, settings: { gatewayKeySource: "none", meetingMode: false } };
    expect(notchLine(noKey, true)).toEqual({ kind: "gateway-key", text: "Add your AI Gateway key in Settings" });
    expect(clickFor(noKey)).toBe("settings");
    expect(statusClick({ kind: "gateway-key", panelOpen: true, bodyShown: false, answerFolded: false })).toBe("settings");
  });

  it("sends a mic error to the Live tab, not the full text of a stale answer", () => {
    const micError = { ...ready, result: answered, mic: { on: false, level: 0, error: "Microphone unavailable: permission denied" } };
    expect(notchLine(micError, true).kind).toBe("mic-error");
    expect(clickFor(micError)).toBe("live");
  });

  it("opens the panel for sign-in, a run in flight and idle status while it is closed", () => {
    expect(clickFor(ready, false)).toBe("panel");
    expect(clickFor({ ...ready, busy: true })).toBe("panel");
    expect(clickFor({ ...ready, busy: true, question: true })).toBe("panel");
    expect(clickFor({ ...ready, busy: true, tools: ["web_search"] })).toBe("panel");
    expect(clickFor({ ...ready, heard: true })).toBe("panel");
    expect(clickFor(ready)).toBe("panel");
    expect(clickFor({ ...ready, mic: { on: true, level: 0, error: null } })).toBe("panel");
  });

  it("classifies the searching and answering working states as working", () => {
    expect(notchLine({ ...ready, busy: true, tools: ["web_search"] }, true)).toEqual({ kind: "working", text: "The AI is searching the web…" });
    expect(notchLine({ ...ready, busy: true, question: true }, true)).toEqual({ kind: "working", text: "The AI is answering…" });
  });

  it("does nothing while loading, or for non-action status with the panel already open", () => {
    expect(notchLine(ready, undefined).kind).toBe("loading");
    expect(statusClick({ ...closed, kind: "loading" })).toBeNull();
    const info: NotchStatusKind[] = ["sign-in", "working", "idle"];
    for (const kind of info) expect(statusClick({ kind, panelOpen: true, bodyShown: false, answerFolded: false })).toBeNull();
  });
});
