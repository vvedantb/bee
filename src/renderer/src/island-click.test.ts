import { describe, expect, it, vi } from "vitest";
import type { PipelineResult } from "../../shared/ipc";
import { focusKeyField, focusKeyFieldWhenReady, KEY_FIELD_FRAMES, statusClick } from "./island-click";
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

  it("sends the missing AI Gateway key status to the key field in Settings, even with the panel open", () => {
    const noKey: Parameters<typeof notchLine>[0] = { ...ready, settings: { gatewayKeySource: "none", meetingMode: false } };
    expect(notchLine(noKey, true)).toEqual({ kind: "gateway-key", text: "Add your AI Gateway key in Settings" });
    expect(clickFor(noKey)).toBe("gateway-key");
    expect(statusClick({ kind: "gateway-key", panelOpen: true, bodyShown: false, answerFolded: false })).toBe("gateway-key");
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

describe("focusKeyField", () => {
  it("scrolls the key field into view, then focuses it without a second scroll", () => {
    const calls: string[] = [];
    const scrollIntoView = vi.fn(() => void calls.push("scroll"));
    const focus = vi.fn(() => void calls.push("focus"));
    expect(focusKeyField({ scrollIntoView, focus })).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(calls).toEqual(["scroll", "focus"]);
  });

  it("does nothing when the key field is not on screen", () => {
    expect(focusKeyField(null)).toBe(false);
  });
});

describe("focusKeyFieldWhenReady", () => {
  /** A key field that turns up on frame `at` (0 = already there), a frame queue run by hand, and how many frames were asked for. */
  function setup(at: number) {
    const field = { scrollIntoView: vi.fn(), focus: vi.fn() };
    const queue: (() => void)[] = [];
    let frame = 0;
    const find = vi.fn(() => (frame >= at ? field : null));
    const nextFrame = (run: () => void) => void queue.push(run);
    const runFrames = () => {
      for (let run = queue.shift(); run; run = queue.shift()) {
        frame += 1;
        run();
      }
    };
    return { field, find, nextFrame, runFrames, frames: () => frame };
  }

  it("focuses the field at once when it is already on screen", async () => {
    const { field, find, nextFrame, frames } = setup(0);
    await expect(focusKeyFieldWhenReady({ find, nextFrame })).resolves.toBe(true);
    expect(field.focus).toHaveBeenCalledOnce();
    expect(frames()).toBe(0);
  });

  it("keeps looking each frame until the field renders, then focuses it once", async () => {
    const { field, find, nextFrame, runFrames, frames } = setup(4);
    const done = focusKeyFieldWhenReady({ find, nextFrame });
    runFrames();
    await expect(done).resolves.toBe(true);
    expect(frames()).toBe(4);
    expect(find).toHaveBeenCalledTimes(5);
    expect(field.focus).toHaveBeenCalledOnce();
  });

  it("gives up after the frame limit when the field never renders", async () => {
    const { field, find, nextFrame, runFrames, frames } = setup(Infinity);
    const done = focusKeyFieldWhenReady({ find, nextFrame });
    runFrames();
    await expect(done).resolves.toBe(false);
    expect(frames()).toBe(KEY_FIELD_FRAMES);
    expect(find).toHaveBeenCalledTimes(KEY_FIELD_FRAMES + 1);
    expect(field.focus).not.toHaveBeenCalled();
  });

  it("honours a custom frame limit", async () => {
    const { find, nextFrame, runFrames, frames } = setup(Infinity);
    const done = focusKeyFieldWhenReady({ find, nextFrame, frames: 3 });
    runFrames();
    await expect(done).resolves.toBe(false);
    expect(frames()).toBe(3);
  });
});
