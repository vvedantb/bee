// Scripted check of the perceived-latency path, with no Electron, mic or Gateway key: synthetic mic frames go through the real
// store, and a fake `window.bee` stands in for main. Covers: the ack shows before speech-to-text finishes, tips stream in, and the
// previous tips stay on screen while the next run is busy.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { END_SILENCE_MS } from "../src/renderer/src/speech";
import type { PipelineResult } from "../src/shared/ipc";

vi.mock("@clerk/electron/react", () => ({ getToken: async () => "token" }));

const RATE = 48_000;
const FRAME = 4096;
const FRAME_MS = (FRAME / RATE) * 1000;
const tone = () => Float32Array.from({ length: FRAME }, (_, index) => 0.2 * Math.sin((2 * Math.PI * 220 * index) / RATE));
const quiet = () => new Float32Array(FRAME);

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  return { promise: new Promise<T>((done) => (resolve = done)), resolve };
}
type Stt = { text: string | null; error: string | null };

const result = (tips: string[]): PipelineResult => ({
  notes: [],
  rankSource: "jev",
  rankError: null,
  tips,
  sources: [],
  guideError: null,
  timingsMs: { retrieve: 1, rank: 2, guide: 3, mcp: 4, lunaFirstToken: 5, lunaTotal: 6 },
});

async function setup() {
  let onFrame: (frame: Float32Array) => void = () => undefined;
  const stts: Array<Deferred<Stt>> = [];
  const runs: Array<{ runId?: string | number; done: Deferred<PipelineResult> }> = [];
  const cancelled: Array<string | number> = [];
  let partialListener: (partial: { runId?: string | number; tips: string[] }) => void = () => undefined;

  vi.doMock("../src/renderer/src/mic", () => ({
    openMic: async () => ({ sampleRate: RATE, start: (cb: typeof onFrame) => (onFrame = cb), attachExtra: () => undefined, stop: () => undefined }),
    openSystemAudio: async () => null,
  }));
  vi.stubGlobal("window", {
    bee: {
      getSettings: async () => ({ gatewayKeySource: "saved", personalisedLinks: false, vmemConnected: false, meetingMode: false }),
      mcp: { list: async () => [] },
      checkForUpdate: async () => ({ currentVersion: "0", latestVersion: null, available: false, error: null }),
      setWindowSize: async () => undefined,
      teams: { tick: async () => Promise.reject(new Error("no relay")), publish: async () => ({ sent: false, error: null }) },
      enrichLinks: async () => ({ chips: [] }),
      transcribe: () => {
        const stt = deferred<Stt>();
        stts.push(stt);
        return stt.promise;
      },
      runPipeline: (request: { runId?: string | number }) => {
        const done = deferred<PipelineResult>();
        runs.push({ runId: request.runId, done });
        return done.promise;
      },
      cancelPipeline: async ({ runId }: { runId: string | number }) => void cancelled.push(runId),
      onLunaActivity: () => () => undefined,
      onLunaPartial: (listener: typeof partialListener) => {
        partialListener = listener;
        return () => undefined;
      },
    },
  });
  const store = await import("../src/renderer/src/store");
  const { notchStatus } = await import("../src/renderer/src/notch");
  await store.actions.toggleMic();

  /** One spoken phrase: speech, then the end silence. The ack fires on the last frame. */
  const speak = () => {
    for (let at = 0; at < 800; at += FRAME_MS) onFrame(tone());
    for (let at = 0; at < END_SILENCE_MS + FRAME_MS; at += FRAME_MS) onFrame(quiet());
  };
  const status = () => notchStatus(store.getBeeState(), true);
  const shown = () => store.displayResult(store.getBeeState());
  return {
    store,
    speak,
    cough: () => {
      onFrame(tone());
      for (let at = 0; at < END_SILENCE_MS + FRAME_MS; at += FRAME_MS) onFrame(quiet());
    },
    status,
    shown,
    stts,
    runs,
    cancelled,
    emitPartial: (tips: string[], runId?: number) => partialListener({ runId, tips }),
  };
}

describe("latency path, scripted", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("../src/renderer/src/mic");
    vi.restoreAllMocks();
  });

  it("shows Got it… at the end of speech, before speech-to-text finishes, and hands over to Thinking…", async () => {
    const t = await setup();
    expect(t.store.getBeeState().heard).toBe(false);
    t.speak();
    // The ack is on screen now. The transcript has not come back, and no run has started.
    expect(t.store.getBeeState().heard).toBe(true);
    expect(t.status()).toBe("Got it…");
    await vi.waitFor(() => expect(t.stts).toHaveLength(1));
    expect(t.runs).toHaveLength(0);
    expect(t.store.getBeeState().busy).toBe(false);

    t.stts[0]?.resolve({ text: "When does SSO ship?", error: null });
    await vi.waitFor(() => expect(t.runs).toHaveLength(1));
    // Busy and heard never leave the pill without a label in between.
    expect(t.store.getBeeState()).toMatchObject({ busy: true, heard: false });
    expect(t.status()).toBe("Thinking…");
  });

  it("does not show Got it… for a cough or click, and no speech-to-text call is made", async () => {
    const t = await setup();
    t.cough();
    expect(t.store.getBeeState().heard).toBe(false);
    expect(t.status()).not.toBe("Got it…");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(t.stts).toHaveLength(0);
  });

  it("clears Got it… when speech-to-text finds no words, and starts no run", async () => {
    const t = await setup();
    t.speak();
    expect(t.store.getBeeState().heard).toBe(true);
    await vi.waitFor(() => expect(t.stts).toHaveLength(1));
    t.stts[0]?.resolve({ text: null, error: null });
    await vi.waitFor(() => expect(t.store.getBeeState().heard).toBe(false));
    expect(t.runs).toHaveLength(0);
    expect(t.status()).not.toBe("Got it…");
  });

  it("streams tips onto the island before the run finishes, then settles on the final result", async () => {
    const t = await setup();
    t.speak();
    await vi.waitFor(() => expect(t.stts).toHaveLength(1));
    t.stts[0]?.resolve({ text: "When does SSO ship?", error: null });
    await vi.waitFor(() => expect(t.runs).toHaveLength(1));
    expect(t.shown()).toBeNull();
    expect(t.store.islandOpen(t.store.getBeeState())).toBe(false);

    t.emitPartial(["SSO ships in Q4 for enterprise [n1]"], t.runs[0]?.runId as number);
    // Still busy, and the first line is already on screen.
    expect(t.store.getBeeState().busy).toBe(true);
    expect(t.shown()?.tips).toEqual(["SSO ships in Q4 for enterprise [n1]"]);
    expect(t.store.islandOpen(t.store.getBeeState())).toBe(true);

    t.emitPartial(["SSO ships in Q4 for enterprise [n1]", "Ask who owns the rollout plan"], t.runs[0]?.runId as number);
    expect(t.shown()?.tips).toHaveLength(2);

    t.runs[0]?.done.resolve(result(["SSO ships in Q4 for enterprise [n1]", "Ask who owns the rollout plan"]));
    await vi.waitFor(() => expect(t.store.getBeeState().busy).toBe(false));
    expect(t.store.getBeeState().partialTips).toBeNull();
    expect(t.store.getBeeState().result?.tips).toHaveLength(2);
  });

  it("keeps the previous tips on screen while the next run is busy, cancels the old run, and ignores its late partials", async () => {
    const t = await setup();
    t.speak();
    await vi.waitFor(() => expect(t.stts).toHaveLength(1));
    t.stts[0]?.resolve({ text: "First question", error: null });
    await vi.waitFor(() => expect(t.runs).toHaveLength(1));
    t.runs[0]?.done.resolve(result(["First answer tip for you"]));
    await vi.waitFor(() => expect(t.store.getBeeState().busy).toBe(false));
    expect(t.status()).toBe("First answer tip for you");

    t.speak();
    await vi.waitFor(() => expect(t.stts).toHaveLength(2));
    // Heard, but the old tip still shows in the body while STT runs.
    expect(t.status()).toBe("Got it…");
    expect(t.shown()?.tips).toEqual(["First answer tip for you"]);
    t.stts[1]?.resolve({ text: "Second question", error: null });
    await vi.waitFor(() => expect(t.runs).toHaveLength(2));

    // Busy with a new run: the old tips stay, the body stays open, and the pill says Thinking….
    expect(t.store.getBeeState().busy).toBe(true);
    expect(t.status()).toBe("Thinking…");
    expect(t.shown()?.tips).toEqual(["First answer tip for you"]);
    expect(t.store.islandOpen(t.store.getBeeState())).toBe(true);
    // Run 1 is cancelled in main.
    expect(t.cancelled).toEqual([t.runs[0]?.runId]);

    // A late partial from the old run is dropped. The new run's partial replaces the old tips.
    t.emitPartial(["Stale tip from the old run"], t.runs[0]?.runId as number);
    expect(t.shown()?.tips).toEqual(["First answer tip for you"]);
    t.emitPartial(["Second answer tip arrives now"], t.runs[1]?.runId as number);
    expect(t.shown()?.tips).toEqual(["Second answer tip arrives now"]);

    // A superseded run's result never lands.
    t.runs[1]?.done.resolve(result(["Second answer tip arrives now"]));
    await vi.waitFor(() => expect(t.store.getBeeState().busy).toBe(false));
    expect(t.store.getBeeState().result?.tips).toEqual(["Second answer tip arrives now"]);
  });
});
