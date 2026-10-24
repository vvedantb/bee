import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineRequest, PipelineResult } from "../../shared/ipc";
import type { startMicSession } from "./speech";

// The store with the mic on, driven by fake timers: preload (window.bee), Clerk, the mic and speech-to-text are stubbed.
type MicArgs = Parameters<typeof startMicSession>[0];

const micSessions: MicArgs[] = [];
vi.mock("@clerk/electron/react", () => ({ getToken: async () => "token" }));
vi.mock("./mic", () => ({
  openMic: async () => ({ sampleRate: 48_000, start: () => undefined, attachExtra: () => undefined, stop: () => undefined }),
  openSystemAudio: async () => null,
}));
vi.mock("./speech", () => ({
  startMicSession: (args: MicArgs) => {
    micSessions.push(args);
    return { push: () => 0, stop: async () => undefined };
  },
}));

const STT_MS = 700;
const CLOSURES = ["District line closed this weekend", "No DLR trains at Tower Hill"];
const WHY = "Weekend closures are planned engineering works on the District line";

function result(tips: string[]): PipelineResult {
  return {
    notes: [],
    rankSource: "fallback",
    rankError: null,
    tips,
    sources: [],
    guideError: null,
    guideNote: null,
    mcpErrors: [],
    timingsMs: { retrieve: 0, rank: 0, guide: 0, mcp: 0, lunaFirstToken: null, lunaTotal: 0 },
  };
}

/** Each run answers from its newest question after runMs, like a Luna turn with a web search. */
function fakeBee(runMs: number) {
  const requests: PipelineRequest[] = [];
  const cancelled: Array<string | number> = [];
  const bee = {
    getSettings: async () => null,
    mcp: { list: async () => [] },
    checkForUpdate: async () => ({ currentVersion: "0.0.0", latestVersion: null, available: false, error: null }),
    setWindowSize: async () => undefined,
    onLunaActivity: () => () => undefined,
    onLunaPartial: () => () => undefined,
    cancelPipeline: async ({ runId }: { runId: string | number }) => {
      cancelled.push(runId);
    },
    runPipeline: async (request: PipelineRequest) => {
      requests.push(request);
      await new Promise((resolve) => setTimeout(resolve, runMs));
      const asked = request.transcript.findLast((line) => line.includes("?") || line.startsWith("why") || line.startsWith("what"));
      return result(asked?.startsWith("why") ? [WHY] : CLOSURES);
    },
  };
  return { bee, requests, cancelled };
}

async function loadStore(runMs: number) {
  const fake = fakeBee(runMs);
  vi.stubGlobal("window", { bee: fake.bee });
  const store = await import("./store");
  await store.actions.toggleMic();
  const mic = micSessions.at(-1);
  if (!mic) throw new Error("mic session not started");
  /** A spoken phrase: it ends, speech-to-text runs, then the line lands. */
  const say = async (text: string) => {
    mic.onSpeechEnd?.();
    await vi.advanceTimersByTimeAsync(STT_MS);
    mic.onLine(text);
    mic.onSettled?.();
    // A new turn's run starts on the next tick.
    await vi.advanceTimersByTimeAsync(0);
  };
  return { ...fake, store, say };
}

describe("store: a follow-up question while the mic stays on", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    micSessions.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("answers within a few seconds, with the earlier answer as context, though speech carries on", async () => {
    const runMs = 4000;
    const { store, say, requests, cancelled } = await loadStore(runMs);
    await say("what's in the news in London");
    await vi.advanceTimersByTimeAsync(runMs);
    expect(store.getBeeState().result?.tips).toEqual(CLOSURES);

    await say("why are there tube closures");
    const asked = requests.at(-1);
    expect(asked?.transcript.at(-1)).toBe("why are there tube closures");
    // A new turn: nothing kept on screen to copy back, but the closures go along as context.
    expect(asked?.shown).toBeUndefined();
    expect(asked?.earlier).toEqual(CLOSURES);

    // The room keeps talking while the answer is searched for. These lines wait for it instead of cancelling it.
    const sent = requests.length;
    for (let line = 0; line < 2; line += 1) {
      await vi.advanceTimersByTimeAsync(800);
      await say("the District line is down again this weekend");
    }
    expect(requests).toHaveLength(sent);
    expect(cancelled).not.toContain(asked?.runId);
    await vi.advanceTimersByTimeAsync(runMs - 2 * (800 + STT_MS));
    expect(store.getBeeState().result?.tips).toContain(WHY);
    expect(store.getBeeState().mic.on).toBe(true);
  });

  it("restarts for a question repeated while the last run is busy, and lands its answer", async () => {
    const runMs = 6000;
    const { store, say, requests } = await loadStore(runMs);
    await say("what's in the news in London");
    await vi.advanceTimersByTimeAsync(runMs);
    await say("why are there tube closures");
    await vi.advanceTimersByTimeAsync(2000);
    await say("why are there tube closures?");
    await vi.advanceTimersByTimeAsync(500);
    const latest = requests.at(-1);
    expect(latest?.transcript.at(-1)).toBe("why are there tube closures?");
    expect(latest?.shown).toBeUndefined();
    await vi.advanceTimersByTimeAsync(runMs);
    expect(store.getBeeState().result?.tips).toEqual([WHY]);
  });
});
