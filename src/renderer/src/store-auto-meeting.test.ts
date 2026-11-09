import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoSignals } from "../../core/auto-meeting-detection";
import { CONFIRM_MS, END_GRACE_MS, MAX_MEETING_MS } from "../../core/auto-meeting-detection";
import type { MeetingSummaryRequest, PipelineResult, SettingsView } from "../../shared/ipc";
import type { MeetingNotice } from "./meeting-notices";
import type { startMicSession } from "./speech";

// Automatic meeting detection in the store, the only way a meeting starts or stops: start turns the mic on and shows one toast,
// the end saves the summary once, turns the mic off and shows one toast after the save. Preload (window.bee), Clerk, the mic and
// the summariser are stubbed: no AI call is made.
type MicArgs = Parameters<typeof startMicSession>[0];

const micSessions: MicArgs[] = [];
let captureStops = 0;
let micFails = false;
vi.mock("@clerk/electron/react", () => ({ getToken: async () => "token" }));
vi.mock("./mic", () => ({
  openMic: async () => {
    if (micFails) throw new Error("blocked");
    return { sampleRate: 48_000, start: () => undefined, stop: () => void (captureStops += 1) };
  },
}));
vi.mock("./speech", () => ({
  startMicSession: (args: MicArgs) => {
    micSessions.push(args);
    return { push: () => 0, stop: async () => undefined };
  },
  framePeak: () => 0,
}));

const SETTINGS: SettingsView = {
  gatewayKeySource: "saved",
  personalisedLinks: false,
  vmemConnected: false,
  sendSessionsToVmem: false,
  meetingMode: false,
  autoMeetingDetection: true,
  interfaceScale: 1,
  motionPreference: "on",
  secretStorage: "os",
  notesDir: "/notes",
  logsDir: "/logs",
  knownNames: [],
  teamsAudioFallbackEnabled: false,
  toggleShortcut: "CommandOrControl+Shift+Space",
  toggleShortcutActive: true,
  askShortcut: "CommandOrControl+Alt+Space",
  askShortcutActive: true,
};

const PRE_JOIN: AutoSignals = { meetingAppPresent: true, inCallTitle: false, preJoinTitle: true, titleClass: "prejoin", micInUseByMeetingApp: false, identity: null };
// In the call with the mic muted: new Teams holds no mic, so only the compact in-call title says so.
const MUTED_CALL: AutoSignals = { meetingAppPresent: true, inCallTitle: true, preJoinTitle: false, titleClass: "incall", micInUseByMeetingApp: false, identity: "weekly sync" };
const CALL: AutoSignals = { meetingAppPresent: true, inCallTitle: true, micInUseByMeetingApp: true, identity: "weekly sync" };
const NONE: AutoSignals = { meetingAppPresent: false, inCallTitle: false, micInUseByMeetingApp: false, identity: null };
const RESULT: PipelineResult = {
  notes: [],
  rankSource: "fallback",
  rankError: null,
  tips: [],
  tipSources: [],
  sources: [],
  guideError: null,
  timingsMs: { retrieve: 0, rank: 0, guide: 0, mcp: 0, lunaFirstToken: null, lunaTotal: 0 },
};

async function loadStore(options: { enabled?: boolean; summary?: "ok" | "fail" | "slow" } = {}) {
  const saved: MeetingSummaryRequest[] = [];
  const overlay: boolean[] = [];
  const shown = { inactive: 0, probes: 0 };
  const events: Array<{ level: string; category: string; event: string; data?: Record<string, unknown> }> = [];
  const notices: string[] = [];
  const all: MeetingNotice[] = [];
  let signals: AutoSignals | "fail" = NONE;
  let callActive = false;
  const settings = { ...SETTINGS, autoMeetingDetection: options.enabled ?? true };
  vi.stubGlobal("window", {
    bee: {
      getSettings: async () => settings,
      saveSettings: async () => settings,
      mcp: { list: async () => [] },
      checkForUpdate: async () => ({ currentVersion: "0.0.0", latestVersion: null, available: false, error: null }),
      setWindowSize: async () => undefined,
      onLunaActivity: () => () => undefined,
      onLunaPartial: () => () => undefined,
      cancelPipeline: async () => undefined,
      computer: { onUpdate: () => () => undefined },
      runPipeline: async () => RESULT,
      conversationEnded: async () => undefined,
      // The summariser stub: counts saves, calls no model.
      writeMeetingSummary: async (request: MeetingSummaryRequest) => {
        saved.push(request);
        if (options.summary === "fail") throw new Error("disk full");
        if (options.summary === "slow") await new Promise((resolve) => setTimeout(resolve, 20_000));
        return { path: "/notes/meeting.md", usedLlm: false, error: null, followUp: [] };
      },
      openMeetingSummary: async () => "",
      meeting: {
        context: async () => ({ active: callActive, id: 1, subject: null, source: "none", card: [] }),
        signals: async () => {
          shown.probes += 1;
          if (signals === "fail") throw new Error("main failed");
          return signals;
        },
        autoOverlay: async (on: boolean) => void overlay.push(on),
        showInactive: async () => void (shown.inactive += 1),
      },
    },
  });
  const store = await import("./store");
  const log = await import("../../core/debug-log");
  log.setDebugSink({ write: (event) => void events.push(event), wants: () => true });
  store.onAutoMeetingNotice((notice) => {
    all.push(notice);
    if (notice.kind === "info") notices.push(notice.message);
  });
  await vi.advanceTimersByTimeAsync(2100);
  const run = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  const say = async (text: string) => {
    const mic = micSessions.at(-1);
    if (!mic) throw new Error("no mic session");
    mic.onSpeechEnd?.();
    mic.onLine(text);
    mic.onSettled?.("words");
    await vi.advanceTimersByTimeAsync(100);
  };
  return { store, saved, overlay, shown, events, notices, all, run, say, set: (next: AutoSignals | "fail") => void (signals = next), setContext: (active: boolean) => void (callActive = active) };
}

const TICK = 5000;
const CONFIRM_RUN = CONFIRM_MS + 3 * TICK;
const END_RUN = END_GRACE_MS + 3 * TICK;

describe("store: automatic meeting detection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T10:00:00Z"));
    vi.resetModules();
    micSessions.length = 0;
    captureStops = 0;
    micFails = false;
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("starts the mic and meeting mode once the call holds, with a quiet notice", async () => {
    const { store, overlay, notices, run, set } = await loadStore();
    set(CALL);
    await run(TICK);
    expect(store.getBeeState().mic.on).toBe(false);
    await run(CONFIRM_RUN);
    expect(store.getBeeState().mic.on).toBe(true);
    expect(micSessions).toHaveLength(1);
    expect(overlay).toEqual([true]);
    expect(notices).toEqual(["Meeting in progress, Bee is active"]);
    expect(store.getBeeState().meetingActive).toBe(true);
    // Still in the call: no second start.
    await run(60_000);
    expect(micSessions).toHaveLength(1);
  });

  it("saves the summary exactly once at the end, stops the mic and lifts meeting mode", async () => {
    const { store, saved, overlay, notices, run, say, set } = await loadStore();
    set(CALL);
    await run(CONFIRM_RUN);
    await say("We will ship the quote on Friday.");
    set(NONE);
    await run(END_GRACE_MS - 2 * TICK);
    // Inside the grace: nothing saved, mic still on.
    expect(saved).toHaveLength(0);
    expect(store.getBeeState().mic.on).toBe(true);
    await run(END_RUN);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.transcript).toContain("We will ship the quote on Friday.");
    expect(store.getBeeState().mic.on).toBe(false);
    expect(captureStops).toBe(1);
    expect(overlay).toEqual([true, false]);
    expect(notices).toEqual(["Meeting in progress, Bee is active", "Meeting ended, notes have been saved"]);
    // Quiet afterwards: no second save, no restart.
    await run(120_000);
    expect(saved).toHaveLength(1);
    expect(micSessions).toHaveLength(1);
  });

  it("leaves the save to the auto machine when the meeting context goes inactive", async () => {
    const { store, saved, run, say, set, setContext } = await loadStore();
    set(CALL);
    setContext(true);
    await run(CONFIRM_RUN);
    await say("We will ship the quote on Friday.");
    set(NONE);
    setContext(false);
    // ~20 s past the context leave debounce (15 s): the old path would have saved by now; the 45 s grace has not run out.
    await run(20_000);
    expect(saved).toHaveLength(0);
    expect(store.getBeeState().mic.on).toBe(true);
    await run(END_RUN);
    expect(saved).toHaveLength(1);
    expect(store.getBeeState().mic.on).toBe(false);
    await run(120_000);
    expect(saved).toHaveLength(1);
  });

  it("does not end on a short drop", async () => {
    const { store, saved, run, say, set } = await loadStore();
    set(CALL);
    await run(CONFIRM_RUN);
    await say("Agenda first.");
    set(NONE);
    await run(2 * TICK);
    set(CALL);
    await run(END_RUN * 2);
    expect(saved).toHaveLength(0);
    expect(store.getBeeState().mic.on).toBe(true);
  });

  it("stops the mic at the end even when nothing was said, without a save", async () => {
    const { store, saved, run, set } = await loadStore();
    set(CALL);
    await run(CONFIRM_RUN);
    set(NONE);
    await run(END_RUN);
    expect(saved).toHaveLength(0);
    expect(store.getBeeState().mic.on).toBe(false);
  });

  it("shows one start toast and one end toast per meeting, with no duplicates on a flap inside the grace", async () => {
    const { store, saved, notices, run, say, set } = await loadStore();
    set(CALL);
    await run(CONFIRM_RUN);
    await say("Agenda first.");
    // The call flaps: gone, back, gone, back, all inside the grace.
    set(NONE);
    await run(2 * TICK);
    set(CALL);
    await run(2 * TICK);
    set(NONE);
    await run(2 * TICK);
    set(CALL);
    await run(END_RUN);
    expect(notices).toEqual(["Meeting in progress, Bee is active"]);
    expect(saved).toHaveLength(0);
    set(NONE);
    await run(END_RUN);
    await run(120_000);
    expect(notices).toEqual(["Meeting in progress, Bee is active", "Meeting ended, notes have been saved"]);
    expect(saved).toHaveLength(1);
    expect(store.getBeeState().meetingActive).toBe(false);
  });

  it("shows the end toast only after the save completes", async () => {
    const { store, notices, run, say, set } = await loadStore({ summary: "slow" });
    set(CALL);
    await run(CONFIRM_RUN);
    await say("Agenda first.");
    set(NONE);
    await run(END_GRACE_MS + TICK);
    expect(store.getBeeState().summary.saving).toBe(true);
    expect(notices).toEqual(["Meeting in progress, Bee is active"]);
    await run(25_000);
    expect(notices).toEqual(["Meeting in progress, Bee is active", "Meeting ended, notes have been saved"]);
  });

  it("says honestly when the notes could not be saved", async () => {
    const { notices, run, say, set } = await loadStore({ summary: "fail" });
    set(CALL);
    await run(CONFIRM_RUN);
    await say("Agenda first.");
    set(NONE);
    await run(END_RUN);
    expect(notices).toEqual(["Meeting in progress, Bee is active", "Meeting ended, but notes could not be saved."]);
  });

  it("does not claim a save when there was nothing to save", async () => {
    const { saved, notices, run, set } = await loadStore();
    set(CALL);
    await run(CONFIRM_RUN);
    set(NONE);
    await run(END_RUN);
    expect(saved).toHaveLength(0);
    expect(notices).toEqual(["Meeting in progress, Bee is active", "Meeting ended."]);
  });

  it("says honestly when the microphone is unavailable at the start, and still ends with one toast", async () => {
    micFails = true;
    const { store, notices, run, set } = await loadStore();
    set(CALL);
    await run(CONFIRM_RUN);
    expect(notices).toEqual(["Meeting in progress, but the microphone is unavailable."]);
    expect(store.getBeeState().meetingActive).toBe(true);
    set(NONE);
    await run(END_RUN);
    expect(notices).toEqual(["Meeting in progress, but the microphone is unavailable.", "Meeting ended."]);
  });

  it("has no manual start or stop: the mic toggle never starts or ends a meeting, or shows a meeting toast", async () => {
    const { store, saved, notices, run, say } = await loadStore();
    await store.actions.toggleMic();
    expect(store.getBeeState().mic.on).toBe(true);
    await say("Remind me about the quote.");
    await store.actions.toggleMic();
    await run(120_000);
    expect(store.getBeeState().meetingActive).toBe(false);
    expect(notices).toEqual([]);
    expect(saved).toHaveLength(0);
  });

  it("does not restart after the user turns the mic off mid-meeting, and still ends the meeting by detection", async () => {
    const { store, saved, notices, run, say, set } = await loadStore();
    set(CALL);
    await run(CONFIRM_RUN);
    await say("Agenda first.");
    await store.actions.toggleMic();
    expect(store.getBeeState().mic.on).toBe(false);
    await run(120_000);
    expect(micSessions).toHaveLength(1);
    expect(store.getBeeState().meetingActive).toBe(true);
    set(NONE);
    await run(END_RUN);
    expect(saved).toHaveLength(1);
    expect(notices).toEqual(["Meeting in progress, Bee is active", "Meeting ended, notes have been saved"]);
  });

  it("stops and saves a meeting that never ends after the maximum length, once, without restarting it", async () => {
    const { store, saved, notices, run, say, set } = await loadStore();
    set(CALL);
    await run(CONFIRM_RUN);
    await say("Agenda first.");
    await run(MAX_MEETING_MS + 60_000);
    expect(saved).toHaveLength(1);
    expect(store.getBeeState().mic.on).toBe(false);
    expect(store.getBeeState().meetingActive).toBe(false);
    await run(30 * 60_000);
    expect(micSessions).toHaveLength(1);
    expect(notices).toEqual(["Meeting in progress, Bee is active", "Meeting ended, notes have been saved"]);
  });

  it("with auto-confirm on, shows only info notices and no buttons", async () => {
    const { all, run, say, set } = await loadStore();
    set(CALL);
    await run(CONFIRM_RUN);
    await say("Agenda first.");
    set(NONE);
    await run(END_RUN);
    expect(all.every((notice) => notice.kind === "info" || notice.kind === "clear")).toBe(true);
    expect(all.map((notice) => notice.kind)).toEqual(["info", "clear", "info"]);
  });
  it("never starts for chat only or a music app", async () => {
    const { store, run, set } = await loadStore();
    set({ meetingAppPresent: true, inCallTitle: false, micInUseByMeetingApp: false, identity: null });
    await run(120_000);
    set(NONE);
    await run(120_000);
    expect(store.getBeeState().mic.on).toBe(false);
  });

  it("keeps the session through a failed signal read", async () => {
    const { store, saved, run, set } = await loadStore();
    set(CALL);
    await run(CONFIRM_RUN);
    set("fail");
    await run(END_RUN * 2);
    expect(store.getBeeState().mic.on).toBe(true);
    expect(saved).toHaveLength(0);
  });

  describe("auto-confirm off: Start / Stop meeting buttons", () => {
    const OFF = { enabled: false };
    const prompts = (all: MeetingNotice[]) => all.filter((notice) => notice.kind === "prompt-start");

    it("prompts after the confirm time and records nothing before the click", async () => {
      const { store, saved, overlay, all, run, set } = await loadStore(OFF);
      set(CALL);
      await run(TICK);
      expect(all).toEqual([]);
      await run(CONFIRM_RUN);
      expect(all).toEqual([{ kind: "prompt-start", message: "Meeting detected" }]);
      await run(5 * 60_000);
      expect(prompts(all)).toHaveLength(1);
      expect(store.getBeeState().mic.on).toBe(false);
      expect(micSessions).toHaveLength(0);
      expect(store.getBeeState().meetingActive).toBe(false);
      expect(store.getBeeState().teamsAudio.listening).toBe(false);
      expect(overlay).toEqual([]);
      expect(saved).toHaveLength(0);
    });

    it("starts the mic once on the Start click, with a persistent Stop control and the notch line", async () => {
      const { store, overlay, all, run, set } = await loadStore(OFF);
      set(CALL);
      await run(CONFIRM_RUN);
      store.actions.acceptMeeting();
      await run(100);
      store.actions.acceptMeeting();
      await run(60_000);
      expect(store.getBeeState().mic.on).toBe(true);
      expect(micSessions).toHaveLength(1);
      expect(store.getBeeState().meetingActive).toBe(true);
      expect(overlay).toEqual([true]);
      expect(all.at(-1)).toEqual({ kind: "prompt-stop", message: "Meeting in progress" });
    });

    it("saves exactly once on the Stop click, shows the end toast and does not prompt again for the same meeting", async () => {
      const { store, saved, overlay, notices, all, run, say, set } = await loadStore(OFF);
      set(CALL);
      await run(CONFIRM_RUN);
      store.actions.acceptMeeting();
      await run(100);
      await say("We will ship the quote on Friday.");
      store.actions.stopMeeting();
      store.actions.stopMeeting();
      await run(100);
      expect(saved).toHaveLength(1);
      expect(store.getBeeState().mic.on).toBe(false);
      expect(store.getBeeState().meetingActive).toBe(false);
      expect(overlay).toEqual([true, false]);
      expect(notices).toEqual(["Meeting ended, notes have been saved"]);
      expect(all.at(-2)).toEqual({ kind: "clear" });
      // The call goes on: no new prompt, no restart.
      await run(10 * 60_000);
      expect(prompts(all)).toHaveLength(1);
      expect(micSessions).toHaveLength(1);
      expect(saved).toHaveLength(1);
    });

    it("prompts again for the same meeting once it has been over for the grace", async () => {
      const { store, run, all, set } = await loadStore(OFF);
      set(CALL);
      await run(CONFIRM_RUN);
      store.actions.acceptMeeting();
      await run(100);
      store.actions.stopMeeting();
      await run(100);
      set(NONE);
      await run(END_RUN);
      set(CALL);
      await run(CONFIRM_RUN);
      expect(prompts(all)).toHaveLength(2);
    });

    it("auto-stops and saves when the call ends after Start without a Stop click", async () => {
      const { store, saved, notices, all, run, say, set } = await loadStore(OFF);
      set(CALL);
      await run(CONFIRM_RUN);
      store.actions.acceptMeeting();
      await run(100);
      await say("Agenda first.");
      set(NONE);
      await run(END_RUN);
      expect(saved).toHaveLength(1);
      expect(store.getBeeState().mic.on).toBe(false);
      expect(notices).toEqual(["Meeting ended, notes have been saved"]);
      expect(all.map((notice) => notice.kind)).toEqual(["prompt-start", "prompt-stop", "clear", "info"]);
    });

    it("dismisses an ignored prompt quietly when the call ends: no save, no end toast, no mic", async () => {
      const { store, saved, notices, all, run, set } = await loadStore(OFF);
      set(CALL);
      await run(CONFIRM_RUN);
      set(NONE);
      await run(END_RUN);
      expect(all).toEqual([{ kind: "prompt-start", message: "Meeting detected" }, { kind: "clear" }]);
      expect(notices).toEqual([]);
      expect(saved).toHaveLength(0);
      expect(micSessions).toHaveLength(0);
      expect(store.getBeeState().meetingActive).toBe(false);
      // A late click on the dismissed prompt does nothing.
      store.actions.acceptMeeting();
      await run(100);
      expect(micSessions).toHaveLength(0);
    });

    it("stops and saves at the maximum length", async () => {
      const { store, saved, run, say, set } = await loadStore(OFF);
      set(CALL);
      await run(CONFIRM_RUN);
      store.actions.acceptMeeting();
      await run(100);
      await say("Agenda first.");
      await run(MAX_MEETING_MS + 60_000);
      expect(saved).toHaveLength(1);
      expect(store.getBeeState().meetingActive).toBe(false);
    });

    it("never prompts for chat only, and a manual mic session never becomes a meeting", async () => {
      const { store, saved, all, run, say, set } = await loadStore(OFF);
      set({ meetingAppPresent: true, inCallTitle: false, micInUseByMeetingApp: false, identity: null });
      await run(120_000);
      set(NONE);
      await store.actions.toggleMic();
      await say("Agenda first.");
      await run(60 * 60_000);
      expect(all).toEqual([]);
      expect(saved).toHaveLength(0);
      expect(store.getBeeState().meetingActive).toBe(false);
    });
  });
  describe("manual mode: Bee is shown for the prompt (it may be hidden)", () => {
    const OFF = { enabled: false };

    it("shows Bee without focus when the Start prompt appears, even for a muted call with no mic", async () => {
      const { shown, all, run, set } = await loadStore(OFF);
      set(MUTED_CALL);
      await run(TICK);
      expect(shown.inactive).toBe(0);
      await run(CONFIRM_RUN);
      expect(all).toEqual([{ kind: "prompt-start", message: "Meeting detected" }]);
      expect(shown.inactive).toBe(1);
      await run(5 * 60_000);
      expect(shown.inactive).toBe(1);
    });

    it("still probes every tick with the setting OFF", async () => {
      const { shown, run, set } = await loadStore(OFF);
      set(NONE);
      const before = shown.probes;
      await run(TICK * 6);
      expect(shown.probes - before).toBeGreaterThanOrEqual(5);
    });

    it("pre-join: shows Bee and the Start prompt at once, records nothing, and the call confirming does not show it again", async () => {
      const { store, saved, shown, all, run, set } = await loadStore(OFF);
      set(PRE_JOIN);
      await run(TICK * 2);
      expect(all).toEqual([{ kind: "prompt-start", message: "Meeting detected" }]);
      expect(shown.inactive).toBe(1);
      expect(store.getBeeState().mic.on).toBe(false);
      expect(store.getBeeState().meetingActive).toBe(false);
      set(MUTED_CALL);
      await run(CONFIRM_RUN * 2);
      expect(all.filter((notice) => notice.kind === "prompt-start")).toHaveLength(1);
      expect(shown.inactive).toBe(1);
      expect(store.getBeeState().mic.on).toBe(false);
      expect(saved).toHaveLength(0);
      // Start still begins the meeting.
      store.actions.acceptMeeting();
      await run(TICK);
      expect(store.getBeeState().mic.on).toBe(true);
      expect(all.at(-1)).toEqual({ kind: "prompt-stop", message: "Meeting in progress" });
    });

    it("never shows Bee for chat only", async () => {
      const { shown, all, run, set } = await loadStore(OFF);
      set({ meetingAppPresent: true, inCallTitle: false, preJoinTitle: false, titleClass: "chat", micInUseByMeetingApp: false, identity: null });
      await run(120_000);
      expect(all).toEqual([]);
      expect(shown.inactive).toBe(0);
    });
  });

  describe("auto-confirm on: pre-join is getting ready, recording waits for the call", () => {
    it("shows Bee and a quiet getting-ready toast on pre-join, and does not record or lift meeting mode", async () => {
      const { store, shown, overlay, notices, run, set } = await loadStore();
      set(PRE_JOIN);
      await run(TICK * 2);
      expect(notices).toEqual(["Meeting starting, Bee is getting ready"]);
      expect(shown.inactive).toBe(1);
      await run(5 * 60_000);
      expect(notices).toHaveLength(1);
      expect(shown.inactive).toBe(1);
      expect(store.getBeeState().mic.on).toBe(false);
      expect(micSessions).toHaveLength(0);
      expect(store.getBeeState().meetingActive).toBe(false);
      expect(overlay).toEqual([]);
    });

    it("starts only once the in-call title is confirmed (muted, no mic)", async () => {
      const { store, overlay, notices, run, set } = await loadStore();
      set(PRE_JOIN);
      await run(TICK * 2);
      set(MUTED_CALL);
      await run(TICK);
      expect(store.getBeeState().mic.on).toBe(false);
      await run(CONFIRM_RUN);
      expect(store.getBeeState().mic.on).toBe(true);
      expect(overlay).toEqual([true]);
      expect(notices).toEqual(["Meeting starting, Bee is getting ready", "Meeting in progress, Bee is active"]);
    });
  });

  describe("per-tick debug log", () => {
    it("logs one auto-tick line per tick with booleans and enums only", async () => {
      const { events, run, set } = await loadStore({ enabled: false });
      set({ ...PRE_JOIN, identity: "secret meeting name" });
      await run(TICK * 3);
      const ticks = events.filter((event) => event.event === "auto-tick");
      expect(ticks.length).toBeGreaterThanOrEqual(3);
      expect(ticks.every((event) => event.level === "debug" && event.category === "meeting")).toBe(true);
      expect(ticks[0]?.data).toMatchObject({ meetingAppPresent: true, titleClass: "prejoin", micInUseByMeetingApp: false, qualifies: false, enabled: false, effect: "prompt", phase: "prompted", promptShown: true, suppressed: false, why: "shown" });
      expect(ticks[1]?.data).toMatchObject({ effect: "none", promptShown: false, why: "already-shown" });
      expect(JSON.stringify(events)).not.toContain("secret meeting name");
    });

    it("says why nothing was shown for chat only", async () => {
      const { events, run, set } = await loadStore({ enabled: false });
      set({ meetingAppPresent: true, inCallTitle: false, titleClass: "chat", micInUseByMeetingApp: false, identity: null });
      await run(TICK * 2);
      expect(events.filter((event) => event.event === "auto-tick").at(-1)?.data).toMatchObject({ titleClass: "chat", phase: "idle", effect: "none", promptShown: false, why: "no-signal" });
    });
  });
});
