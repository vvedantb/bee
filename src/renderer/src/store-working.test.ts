import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pipelineRequestSchema, type LunaActivity, type PipelineRequest, type PipelineResult } from "../../shared/ipc";
import type { startMicSession } from "./speech";

// The pill's working state from the moment a line lands until the run settles: thinking or answering, then searching while
// web_search runs, then the tips. Preload (window.bee), Clerk, the mic and speech-to-text are stubbed, as in store.test.ts.
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

const RUN_MS = 3000;

function result(tips: string[], sources: PipelineResult["sources"] = []): PipelineResult {
  return {
    notes: [],
    rankSource: "fallback",
    rankError: null,
    tips,
    sources,
    guideError: null,
    guideNote: null,
    mcpErrors: [],
    timingsMs: { retrieve: 0, rank: 0, guide: 0, mcp: 0, lunaFirstToken: null, lunaTotal: 0 },
  };
}

async function loadStore(answers: PipelineResult[]) {
  const requests: PipelineRequest[] = [];
  let activity: (event: LunaActivity) => void = () => undefined;
  vi.stubGlobal("window", {
    bee: {
      getSettings: async () => null,
      mcp: { list: async () => [] },
      checkForUpdate: async () => ({ currentVersion: "0.0.0", latestVersion: null, available: false, error: null }),
      setWindowSize: async () => undefined,
      onLunaActivity: (listener: typeof activity) => {
        activity = listener;
        return () => undefined;
      },
      onLunaPartial: () => () => undefined,
      cancelPipeline: async () => undefined,
      runPipeline: async (request: PipelineRequest) => {
        requests.push(pipelineRequestSchema.parse(request));
        const answer = answers[requests.length - 1] ?? result([]);
        await new Promise((resolve) => setTimeout(resolve, RUN_MS));
        return answer;
      },
    },
  });
  const store = await import("./store");
  const { notchStatus } = await import("./notch");
  await store.actions.toggleMic();
  const mic = micSessions.at(-1);
  if (!mic) throw new Error("mic session not started");
  /** A line lands from speech-to-text. The run starts on the next tick. */
  const say = (text: string) => {
    mic.onSpeechEnd?.();
    mic.onLine(text);
    mic.onSettled?.();
  };
  const emit = (tool: string, phase: "start" | "end") => activity({ runId: requests.at(-1)?.runId, tool, phase });
  const status = () => notchStatus(store.getBeeState(), true);
  return { store, say, emit, status, requests };
}

describe("store: working state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    micSessions.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows the AI answering a question at once, searching while web_search runs, then the answer", async () => {
    const { store, say, emit, status } = await loadStore([result(["Planned closures on the District line"], [{ title: "TfL", url: "https://tfl.gov.uk/status" }])]);
    say("what's in the news in London today");
    // Before the run has returned or streamed anything.
    expect(store.getBeeState()).toMatchObject({ busy: true, question: true, tools: [] });
    expect(status()).toBe("The AI is answering…");

    await vi.advanceTimersByTimeAsync(0);
    emit("web_search", "start");
    expect(store.getBeeState().tools).toEqual(["web_search"]);
    expect(status()).toBe("The AI is searching the web…");

    // The search ended; the answer is still being written. The pill no longer says it is searching.
    emit("web_search", "end");
    expect(status()).toBe("The AI is answering…");

    await vi.advanceTimersByTimeAsync(RUN_MS);
    expect(store.getBeeState()).toMatchObject({ busy: false, tools: [] });
    expect(status()).toBe("Planned closures on the District line");
  });

  it("says Thinking… for a line that is not a question", async () => {
    const { store, say, status } = await loadStore([result(["Ask about the discount"])]);
    say("let's pick up the Acme renewal");
    expect(store.getBeeState()).toMatchObject({ busy: true, question: false });
    expect(status()).toBe("Thinking…");
  });

  it("tells main a follow-up comes after a searched answer, and not after a sum", async () => {
    const { say, emit, requests } = await loadStore([result(["Closures this weekend"]), result(["Engineering works"]), result(["2,700"]), result(["Rain"])]);
    say("what's in the news in London today");
    await vi.advanceTimersByTimeAsync(0);
    expect(requests[0]?.searched).toBeUndefined();
    emit("web_search", "start");
    emit("web_search", "end");
    await vi.advanceTimersByTimeAsync(RUN_MS);

    say("why are there tube closures");
    await vi.advanceTimersByTimeAsync(0);
    expect(requests[1]?.searched).toBe(true);
    // This run does not search and returns no sources: the next turn is not a follow-up to a search.
    await vi.advanceTimersByTimeAsync(RUN_MS);

    say("what is fifteen percent of eighteen thousand");
    await vi.advanceTimersByTimeAsync(RUN_MS);
    say("will it rain later");
    await vi.advanceTimersByTimeAsync(0);
    expect(requests[2]?.searched).toBeUndefined();
    expect(requests[3]?.searched).toBeUndefined();
  });

  it("counts result sources as a search", async () => {
    const { say, requests } = await loadStore([result(["Closures"], [{ title: "BBC", url: "https://www.bbc.co.uk/news" }]), result(["Works"])]);
    say("what's in the news in London today");
    await vi.advanceTimersByTimeAsync(RUN_MS);
    say("why are there tube closures");
    await vi.advanceTimersByTimeAsync(0);
    expect(requests[1]?.searched).toBe(true);
  });
});

describe("workingLabel", () => {
  const base = { tools: [], revising: false, question: false };

  it("puts web search first, then other tools, then Updating…, then answering, then thinking", async () => {
    const { workingLabel } = await import("./notch");
    expect(workingLabel({ ...base, tools: ["vmem__search", "web_search"], revising: true, question: true })).toBe("The AI is searching the web…");
    expect(workingLabel({ ...base, tools: ["read_file"], revising: true })).toBe("Reading notes");
    expect(workingLabel({ ...base, revising: true, question: true })).toBe("Updating…");
    expect(workingLabel({ ...base, question: true })).toBe("The AI is answering…");
    expect(workingLabel(base)).toBe("Thinking…");
  });

  it("never names Luna", async () => {
    const { workingLabel } = await import("./notch");
    for (const state of [base, { ...base, question: true }, { ...base, tools: ["web_search"] }]) expect(workingLabel(state)).not.toMatch(/luna/i);
  });
});
