import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoSignals } from "../../core/auto-meeting-detection";
import { CONFIRM_MS, END_GRACE_MS } from "../../core/auto-meeting-detection";
import type { MeetingSummaryRequest, PipelineResult, SettingsView } from "../../shared/ipc";
import type { startMicSession } from "./speech";

// Automatic meeting detection in the store: start turns the mic on, the end saves the summary once and turns the mic off, and a
// manual stop is not undone. Preload (window.bee), Clerk, the mic and the summariser are stubbed: no AI call is made.
type MicArgs = Parameters<typeof startMicSession>[0];

const micSessions: MicArgs[] = [];
let captureStops = 0;
vi.mock("@clerk/electron/react", () => ({ getToken: async () => "token" }));
vi.mock("./mic", () => ({
  openMic: async () => ({ sampleRate: 48_000, start: () => undefined, stop: () => void (captureStops += 1) }),
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
};

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

async function loadStore(options: { enabled?: boolean } = {}) {
  const saved: MeetingSummaryRequest[] = [];
  const overlay: boolean[] = [];
  const notices: string[] = [];
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
        return { path: "/notes/meeting.md", usedLlm: false, error: null, followUp: [] };
      },
      openMeetingSummary: async () => "",
      teams: { tick: async () => ({ view: null, lines: [] }) },
      meeting: {
        context: async () => ({ active: callActive, id: 1, subject: null, source: "none", card: [] }),
        signals: async () => {
          if (signals === "fail") throw new Error("main failed");
          return signals;
        },
        autoOverlay: async (on: boolean) => void overlay.push(on),
      },
    },
  });
  const store = await import("./store");
  store.onAutoMeetingNotice((message) => notices.push(message));
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
  return { store, saved, overlay, notices, run, say, set: (next: AutoSignals | "fail") => void (signals = next), setContext: (active: boolean) => void (callActive = active) };
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
    expect(notices).toEqual(["Meeting detected. Bee is listening."]);
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
    expect(notices).toEqual(["Meeting detected. Bee is listening.", "Meeting ended. Summary saved."]);
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

  it("does not restart the same meeting after the End meeting button", async () => {
    const { store, saved, run, say, set } = await loadStore();
    set(CALL);
    await run(CONFIRM_RUN);
    await say("Agenda first.");
    await store.actions.endMeeting();
    expect(saved).toHaveLength(1);
    expect(store.getBeeState().mic.on).toBe(false);
    await run(120_000);
    expect(micSessions).toHaveLength(1);
    expect(store.getBeeState().mic.on).toBe(false);
  });

  it("does not restart after the user turns the mic off", async () => {
    const { store, run, set } = await loadStore();
    set(CALL);
    await run(CONFIRM_RUN);
    await store.actions.toggleMic();
    expect(store.getBeeState().mic.on).toBe(false);
    await run(120_000);
    expect(micSessions).toHaveLength(1);
  });

  it("never starts with the setting off", async () => {
    const { store, overlay, run, set } = await loadStore({ enabled: false });
    set(CALL);
    await run(120_000);
    expect(store.getBeeState().mic.on).toBe(false);
    expect(micSessions).toHaveLength(0);
    expect(overlay).toEqual([]);
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
});
