// Scripted check of the perceived-latency path, with no Electron, mic or Gateway key: synthetic mic frames go through the real
// store, and a fake `window.bee` stands in for main. Covers: the ack shows before speech-to-text finishes, tips stream in, and a
// fresh question after an answer settled shows only the new answer. Live steering: a line spoken over a run cancels it (unless it
// is nearly done), keeps complete tips on screen, and merges the new answer over them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { END_SILENCE_MS } from "../src/renderer/src/speech";
import type { LunaActivity, PipelineResult } from "../src/shared/ipc";

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
  const runs: Array<{ runId?: string | number; request: { transcript: string[]; shown?: string[] }; done: Deferred<PipelineResult> }> = [];
  const cancelled: Array<string | number> = [];
  const sizes: string[] = [];
  let tickImpl: () => Promise<unknown> = () => Promise.reject(new Error("no relay"));
  let partialListener: (partial: { runId?: string | number; tips: string[] }) => void = () => undefined;
  let activityListener: (activity: LunaActivity) => void = () => undefined;

  vi.doMock("../src/renderer/src/mic", () => ({
    openMic: async () => ({ sampleRate: RATE, start: (cb: typeof onFrame) => (onFrame = cb), attachExtra: () => undefined, stop: () => undefined }),
    openSystemAudio: async () => null,
  }));
  vi.stubGlobal("window", {
    bee: {
      getSettings: async () => ({ gatewayKeySource: "saved", personalisedLinks: false, vmemConnected: false, meetingMode: false }),
      mcp: { list: async () => [] },
      checkForUpdate: async () => ({ currentVersion: "0", latestVersion: null, available: false, error: null }),
      setWindowSize: async (size: string) => void sizes.push(size),
      teams: { tick: () => tickImpl(), publish: async () => ({ sent: false, error: null }) },
      enrichLinks: async () => ({ chips: [] }),
      transcribe: () => {
        const stt = deferred<Stt>();
        stts.push(stt);
        return stt.promise;
      },
      runPipeline: (request: { runId?: string | number; transcript: string[]; shown?: string[] }) => {
        const done = deferred<PipelineResult>();
        runs.push({ runId: request.runId, request, done });
        return done.promise;
      },
      cancelPipeline: async ({ runId }: { runId: string | number }) => void cancelled.push(runId),
      onLunaActivity: (listener: typeof activityListener) => {
        activityListener = listener;
        return () => undefined;
      },
      onLunaPartial: (listener: typeof partialListener) => {
        partialListener = listener;
        return () => undefined;
      },
    },
  });
  const store = await import("../src/renderer/src/store");
  const { logoState, notchStatus } = await import("../src/renderer/src/notch");
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
    logo: () => logoState(store.getBeeState()),
    emitActivity: (activity: LunaActivity) => activityListener(activity),
    stts,
    runs,
    cancelled,
    /** Every window size the store asked main for, in order. */
    sizes,
    emitPartial: (tips: string[], runId?: number) => partialListener({ runId, tips }),
    /** Steering runs start after a 500 ms debounce, so waits are longer than a bare tick. */
    waitRuns: (count: number) => vi.waitFor(() => expect(runs).toHaveLength(count), { timeout: 4000 }),
    /** What the next relay ticks return (the store polls every 2 s). */
    setTick: (impl: () => Promise<unknown>) => void (tickImpl = impl),
    runId: (index: number) => runs[index]?.runId as number,
  };
}

describe("latency path, scripted", () => {
  const intervals: Array<ReturnType<typeof setInterval>> = [];
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    // Each fresh store polls the relay every 2 s. Stop old ones, so only the current store reads the fake tick.
    const realSetInterval = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((...args: Parameters<typeof setInterval>) => {
      const id = realSetInterval(...args);
      intervals.push(id);
      return id;
    }) as typeof setInterval);
  });
  afterEach(() => {
    for (const id of intervals.splice(0)) clearInterval(id);
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
    await t.waitRuns(1);
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
    await t.waitRuns(1);
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

  it("drives the notch logo through a run: listening, thinking, searching, tool, done once, then listening", async () => {
    const t = await setup();
    expect(t.logo()).toBe("listening");
    t.speak();
    await vi.waitFor(() => expect(t.stts).toHaveLength(1));
    t.stts[0]?.resolve({ text: "Who won last night?", error: null });
    await t.waitRuns(1);
    const run = t.runId(0);
    expect(t.logo()).toBe("thinking");

    t.emitActivity({ runId: run, tool: "web_search", phase: "start" });
    expect(t.logo()).toBe("searching");
    expect(t.status()).toBe("Searching the web");
    t.emitActivity({ runId: run, tool: "vmem__search", phase: "start" });
    // Web search wins while both are in flight.
    expect(t.logo()).toBe("searching");
    t.emitActivity({ runId: run, tool: "web_search", phase: "end" });
    expect(t.logo()).toBe("tool");
    // Another run's events are ignored.
    t.emitActivity({ runId: run + 1, tool: "vmem__search", phase: "end" });
    expect(t.logo()).toBe("tool");
    t.emitActivity({ runId: run, tool: "vmem__search", phase: "end" });
    expect(t.logo()).toBe("thinking");

    t.runs[0]?.done.resolve(result(["They won 2-1 in extra time"]));
    await vi.waitFor(() => expect(t.store.getBeeState().busy).toBe(false));
    expect(t.logo()).toBe("done");
    await vi.waitFor(() => expect(t.logo()).toBe("listening"), { timeout: 3000 });
  });

  it("clears tool calls when the run ends without their end events", async () => {
    const t = await setup();
    t.speak();
    await vi.waitFor(() => expect(t.stts).toHaveLength(1));
    t.stts[0]?.resolve({ text: "Check the notes", error: null });
    await t.waitRuns(1);
    t.emitActivity({ runId: t.runId(0), tool: "read_file", phase: "start" });
    expect(t.logo()).toBe("tool");
    t.runs[0]?.done.resolve(result([]));
    await vi.waitFor(() => expect(t.store.getBeeState().busy).toBe(false));
    expect(t.store.getBeeState().tools).toEqual([]);
    // No tips: no done loop.
    expect(t.logo()).toBe("listening");
  });

  it("drops the last answer for a fresh question after it settled: only the new answer shows, and late partials are ignored", async () => {
    const t = await setup();
    t.speak();
    await vi.waitFor(() => expect(t.stts).toHaveLength(1));
    t.stts[0]?.resolve({ text: "First question", error: null });
    await t.waitRuns(1);
    t.runs[0]?.done.resolve(result(["First answer tip for you"]));
    await vi.waitFor(() => expect(t.store.getBeeState().busy).toBe(false));
    expect(t.status()).toBe("First answer tip for you");

    t.speak();
    await vi.waitFor(() => expect(t.stts).toHaveLength(2));
    // Heard: the old answer is still the latest until the new line lands.
    expect(t.status()).toBe("Got it…");
    t.stts[1]?.resolve({ text: "Second question", error: null });
    await t.waitRuns(2);

    // A new turn: nothing kept, no earlier answer on screen, the pill thinks.
    expect(t.store.getBeeState()).toMatchObject({ busy: true, revising: false, keptTips: [] });
    expect(t.status()).toBe("Thinking…");
    expect(t.shown()).toBeNull();
    expect(t.runs[1]?.request.shown).toBeUndefined();

    // A late partial from the old run is dropped; the new run's partial shows alone.
    t.emitPartial(["Stale tip from the old run"], t.runs[0]?.runId as number);
    expect(t.shown()).toBeNull();
    t.emitPartial(["Second answer tip arrives now"], t.runs[1]?.runId as number);
    expect(t.shown()?.tips).toEqual(["Second answer tip arrives now"]);

    t.runs[1]?.done.resolve(result(["Second answer tip arrives now"]));
    await vi.waitFor(() => expect(t.store.getBeeState().busy).toBe(false));
    expect(t.store.getBeeState().result?.tips).toEqual(["Second answer tip arrives now"]);
  });

  it("keeps the answer for a phrase spoken over it, even when speech-to-text finishes after the run settled", async () => {
    const t = await setup();
    t.store.actions.simulateLine("Could we offer twenty percent off?");
    await t.waitRuns(1);
    // First tip complete, second in progress: the user interrupts.
    t.emitPartial(["Offer 10% if they sign this week [n1]", "Ask who owns the rol"], t.runId(0));
    t.speak();
    await vi.waitFor(() => expect(t.stts).toHaveLength(1));
    t.runs[0]?.done.resolve(result(["Offer 10% if they sign this week [n1]", "Ask who owns the rollout plan"]));
    await vi.waitFor(() => expect(t.store.getBeeState().busy).toBe(false));

    t.stts[0]?.resolve({ text: "No, make it fifteen", error: null });
    await t.waitRuns(2);
    // An interruption steers: the answer stays (dimmed) and goes to Luna as the keep list.
    expect(t.runs[1]?.request.shown).toEqual(["Offer 10% if they sign this week [n1]", "Ask who owns the rollout plan"]);
    expect(t.status()).toBe("Updating…");
    expect(t.shown()?.tips).toEqual(["Offer 10% if they sign this week [n1]", "Ask who owns the rollout plan"]);
  });

  it("opens the one-line answer in full in the island, not the panel, and folds it back on a click outside", async () => {
    const t = await setup();
    t.store.actions.simulateLine("Does Convex support local deployments?");
    await t.waitRuns(1);
    t.runs[0]?.done.resolve(result(["Convex does support local deployments, per the docs."]));
    await vi.waitFor(() => expect(t.store.getBeeState().busy).toBe(false));
    await t.store.actions.dismissIsland();
    // Folded: the pill shows the answer on one line, and the window is the collapsed notch.
    expect(t.status()).toBe("Convex does support local deployments, per the docs.");
    expect(t.store.answerFolded(t.store.getBeeState())).toBe(true);
    expect(t.sizes.at(-1)).toBe("collapsed");

    t.store.actions.openFullText();
    expect(t.store.getBeeState()).toMatchObject({ fullText: true, expanded: false, dismissed: false });
    expect(t.store.islandOpen(t.store.getBeeState())).toBe(true);
    // The window grows for the island body, never to the panel.
    await vi.waitFor(() => expect(t.sizes.at(-1)).toBe("response"));
    expect(t.sizes).not.toContain("expanded");

    t.store.actions.clickedOutside();
    await vi.waitFor(() => expect(t.store.getBeeState()).toMatchObject({ fullText: false, dismissed: true }));
    await vi.waitFor(() => expect(t.sizes.at(-1)).toBe("collapsed"));
    // The answer is still the latest: it stays on the pill's one line.
    expect(t.status()).toBe("Convex does support local deployments, per the docs.");
  });

  describe("live steering", () => {
    const A = "Offer 10% if they sign this week [n1]";
    const B = "SSO ships in Q4 for enterprise [n2]";
    const C = "Ask who owns the rollout plan";

    /** One line in as typed text: the same path as a transcribed phrase. */
    const say = (t: Awaited<ReturnType<typeof setup>>, text: string) => t.store.actions.simulateLine(text);
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    it("starts the first question of a turn at once, without the 500 ms debounce", async () => {
      const t = await setup();
      say(t, "Could we offer twenty percent off?");
      await pause(100);
      expect(t.runs).toHaveLength(1);
    });

    it("debounces a second utterance mid-answer", async () => {
      const t = await setup();
      say(t, "Could we offer twenty percent off?");
      await t.waitRuns(1);
      say(t, "Also, when does SSO ship?");
      await pause(250);
      expect(t.runs).toHaveLength(1);
      await t.waitRuns(2);
    });

    it("starts afresh for a new question after the answer settled: nothing kept, and each turn joins the session once", async () => {
      const t = await setup();
      say(t, "Could we offer twenty percent off?");
      await t.waitRuns(1);
      expect(t.runs[0]?.request.shown).toBeUndefined();
      t.runs[0]?.done.resolve(result([A]));
      await vi.waitFor(() => expect(t.store.getBeeState().busy).toBe(false));
      expect(t.store.getBeeState().session.tips).toEqual([A]);

      say(t, "Also, when does SSO ship?");
      // A fresh turn: the old answer goes at once, nothing dimmed, the pill thinks.
      expect(t.store.getBeeState()).toMatchObject({ busy: true, revising: false, keptTips: [], result: null });
      expect(t.shown()).toBeNull();
      await t.waitRuns(2);
      expect(t.runs[1]?.request.shown).toBeUndefined();
      // Luna still reads the recent transcript for context.
      expect(t.runs[1]?.request.transcript).toHaveLength(2);

      t.runs[1]?.done.resolve(result([B]));
      await vi.waitFor(() => expect(t.store.getBeeState().busy).toBe(false));
      expect(t.store.getBeeState().result?.tips).toEqual([B]);
      expect(t.store.getBeeState().session.tips).toEqual([A, B]);
    });

    it("cancels a run that is not nearly done, and keeps only its complete tips", async () => {
      const t = await setup();
      say(t, "Could we offer twenty percent off?");
      await t.waitRuns(1);
      // One streamed line may still be growing: it is dropped from the keep list.
      t.emitPartial(["Offer 10% if they sign th"], t.runId(0));
      say(t, "Also, when does SSO ship?");
      await t.waitRuns(2);
      expect(t.cancelled).toEqual([t.runId(0)]);
      expect(t.runs[1]?.request.shown).toBeUndefined();
      expect(t.shown()?.tips ?? []).toEqual([]);
    });

    it("does not cancel inside the commit window; the new run starts after the first finishes, with the shown tips", async () => {
      const t = await setup();
      say(t, "Could we offer twenty percent off?");
      await t.waitRuns(1);
      // First tip complete, second in progress: nearly done.
      t.emitPartial([A, "Ask who owns the rol"], t.runId(0));
      say(t, "Also, when does SSO ship?");
      await pause(900);
      expect(t.runs).toHaveLength(1);
      expect(t.cancelled).toEqual([]);
      expect(t.store.getBeeState().busy).toBe(true);

      t.runs[0]?.done.resolve(result([A, C]));
      await t.waitRuns(2);
      // The first answer is on screen and is the keep list. It was not a settled turn, so the session has no tips yet.
      expect(t.runs[1]?.request.shown).toEqual([A, C]);
      expect(t.store.getBeeState().session.tips).toEqual([]);
      expect(t.shown()?.tips).toEqual([A, C]);

      t.emitPartial([A, C, B], t.runId(1));
      t.runs[1]?.done.resolve(result([A, C, B]));
      await vi.waitFor(() => expect(t.store.getBeeState().busy).toBe(false));
      expect(t.store.getBeeState().result?.tips).toEqual([A, C, B]);
      expect(t.store.getBeeState().session.tips).toEqual([A, C, B]);
    });

    it("replaces a kept tip the new run corrects, and keeps the tips when the run returns none", async () => {
      const t = await setup();
      say(t, "Could we offer twenty percent off?");
      await t.waitRuns(1);
      // A correction while Luna is still answering (in the commit window, so it waits for this run).
      t.emitPartial([A, "Ask who owns the rol"], t.runId(0));
      say(t, "No, I meant when SSO ships");
      t.runs[0]?.done.resolve(result([A, C]));
      await t.waitRuns(2);
      expect(t.runs[1]?.request.shown).toEqual([A, C]);

      // The next line, aimed at someone else, comes while the corrected answer is still streaming.
      t.emitPartial([A, B], t.runId(1));
      say(t, "Dave, can you share your screen");
      t.runs[1]?.done.resolve(result([A, B]));
      await t.waitRuns(3);
      expect(t.store.getBeeState().result?.tips).toEqual([A, B]);
      expect(t.runs[2]?.request.shown).toEqual([A, B]);
      // Luna says NONE, and the tips stay.
      t.runs[2]?.done.resolve(result([]));
      await vi.waitFor(() => expect(t.store.getBeeState().busy).toBe(false));
      expect(t.store.getBeeState().result?.tips).toEqual([A, B]);
    });

    it("joins filler to the transcript but never starts or cancels a run", async () => {
      const t = await setup();
      say(t, "yeah");
      say(t, "Okay.");
      await pause(700);
      expect(t.runs).toHaveLength(0);
      expect(t.store.getBeeState()).toMatchObject({ busy: false });
      expect(t.store.getBeeState().session.lines).toHaveLength(2);

      say(t, "When does SSO ship?");
      await t.waitRuns(1);
      expect(t.runs[0]?.request.transcript).toEqual(["yeah", "Okay.", "When does SSO ship?"]);

      // Filler mid-answer: no cancel, no new run, the pill keeps its label.
      say(t, "mhm, uh-huh");
      await pause(700);
      expect(t.runs).toHaveLength(1);
      expect(t.cancelled).toEqual([]);
      expect(t.store.getBeeState().session.lines).toHaveLength(4);
      expect(t.store.getBeeState().busy).toBe(true);
    });

    it("starts the first line at once, then restarts once for a second line 100 ms later", async () => {
      const t = await setup();
      say(t, "Could we offer twenty percent off");
      await t.waitRuns(1);
      await pause(100);
      say(t, "if they sign this week?");
      await t.waitRuns(2);
      await pause(700);
      // One restart, not one per line: the second run reads both lines.
      expect(t.runs).toHaveLength(2);
      expect(t.runs[1]?.request.transcript).toHaveLength(2);
      expect(t.cancelled).toEqual([t.runId(0)]);
    });

    it("makes the 4th restart wait for a pause in speech", { timeout: 15_000 }, async () => {
      const t = await setup();
      say(t, "Question number one about pricing");
      await t.waitRuns(1);
      // Three restarts, each cancelling the run before it.
      for (let n = 2; n <= 4; n++) {
        say(t, `Another question number ${n} about pricing`);
        await t.waitRuns(n);
      }
      expect(t.cancelled).toHaveLength(3);
      // The 4th waits for 1.5 s of quiet: nothing at 1 s, a run by 3 s.
      say(t, "One more question about the roadmap");
      await pause(1000);
      expect(t.runs).toHaveLength(4);
      await t.waitRuns(5);
    });

    it("keeps link chips and the turn through a burst, and starts afresh once the answer settled", async () => {
      const t = await setup();
      say(t, "See https://example.com/pricing for the plan");
      await t.waitRuns(1);
      const chips = t.store.getBeeState().chips;
      expect(chips.length).toBeGreaterThan(0);
      say(t, "and also look at https://github.com/acme/repo");
      await t.waitRuns(2);
      // The first chip stays and the second joins it.
      expect(t.store.getBeeState().chips.length).toBeGreaterThan(chips.length);
      expect(t.store.getBeeState().chips[0]).toEqual(chips[0]);

      t.runs[1]?.done.resolve(result([A]));
      await vi.waitFor(() => expect(t.store.getBeeState().busy).toBe(false));
      // The answer settled, so the next line is a new turn however soon it comes: nothing is kept and chips restart.
      say(t, "Different topic, what is the salary band?");
      await t.waitRuns(3);
      expect(t.runs[2]?.request.shown).toBeUndefined();
      expect(t.store.getBeeState()).toMatchObject({ revising: false, keptTips: [] });
      expect(t.store.getBeeState().chips).toEqual([]);
      expect(t.shown()).toBeNull();
    });

    it("dismissing the island does not cancel the run, and the next line starts afresh", async () => {
      const t = await setup();
      say(t, "Could we offer twenty percent off?");
      await t.waitRuns(1);
      t.emitPartial([A], t.runId(0));
      await t.store.actions.dismissIsland();
      expect(t.store.getBeeState().dismissed).toBe(true);
      expect(t.cancelled).toEqual([]);
      expect(t.store.getBeeState().busy).toBe(true);

      say(t, "Also, when does SSO ship?");
      await t.waitRuns(2);
      expect(t.cancelled).toEqual([t.runId(0)]);
      expect(t.runs[1]?.request.shown).toBeUndefined();
    });

    it("a teammate's line follows the same path and reads Updating…", { timeout: 15_000 }, async () => {
      const t = await setup();
      say(t, "Could we offer twenty percent off?");
      await t.waitRuns(1);
      // Luna is still answering when the teammate speaks.
      t.emitPartial([A, "Ask who owns the rol"], t.runId(0));
      // A relay tick delivers a line from a teammate (the store reads it through the same addLines path).
      const lines = [{ id: "room:1", own: false, speakerId: "u2", speakerName: "Alice", text: "What about the SSO date", clientTs: Date.now(), serverTs: null }];
      let sent = false;
      t.setTick(async () => {
        const batch = sent ? [] : lines;
        sent = true;
        return { view: { room: null, prompt: null, merge: null, me: null }, lines: batch };
      });
      await vi.waitFor(() => expect(t.store.getBeeState().revising).toBe(true), { timeout: 4000 });
      expect(t.status()).toBe("Updating…");
      t.runs[0]?.done.resolve(result([A, C]));
      await t.waitRuns(2);
      expect(t.runs[1]?.request.shown).toEqual([A, C]);
      expect(t.runs[1]?.request.transcript.at(-1)).toBe("Alice: What about the SSO date");
    });
  });
});
