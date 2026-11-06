import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  pipelineRequestSchema,
  type MeetingWindowCaptions,
  type PipelineRequest,
  type PipelineResult,
  type SettingsView,
  type TeamsAudioStatus,
  type TeamsTickResult,
  type TeamsView,
} from "../../shared/ipc";
import type { startMicSession } from "./speech";
import type { TeamsAudioCapture, TeamsAudioOpen } from "./teams-audio";

// The Teams audio fallback in the store: lines from the Teams app join the session like captions, are deduped against speech
// Bee already has, and are never shared. The capture runs beside the mic, never in it. Preload (window.bee), Clerk, the mic,
// speech-to-text and the Teams audio capture are stubbed, as in store.test.ts.
type MicArgs = Parameters<typeof startMicSession>[0];

const sessions: MicArgs[] = [];
const capture = vi.hoisted(() => ({
  open: async (): Promise<TeamsAudioOpen> => ({ capture: null, failure: "failed" }),
  opened: 0,
  stopped: 0,
}));
vi.mock("@clerk/electron/react", () => ({ getToken: async () => "token" }));
vi.mock("./mic", () => ({
  openMic: async () => ({ sampleRate: 48_000, start: () => undefined, stop: () => undefined }),
}));
vi.mock("./speech", () => ({
  startMicSession: (args: MicArgs) => {
    sessions.push(args);
    return { push: () => 0, stop: async () => undefined };
  },
}));
vi.mock("./teams-audio", () => ({
  openTeamsAudio: async () => {
    capture.opened += 1;
    return capture.open();
  },
}));

const EMPTY: PipelineResult = {
  notes: [],
  rankSource: "fallback",
  rankError: null,
  tips: [],
  sources: [],
  guideError: null,
  guideNote: null,
  mcpErrors: [],
  timingsMs: { retrieve: 0, rank: 0, guide: 0, mcp: 0, lunaFirstToken: null, lunaTotal: 0 },
};

const SETTINGS: SettingsView = {
  gatewayKeySource: "saved",
  personalisedLinks: false,
  vmemConnected: false,
  sendSessionsToVmem: false,
  meetingMode: false,
  interfaceScale: 1,
  motionPreference: "on",
  secretStorage: "os",
  notesDir: "/notes",
  logsDir: "/logs",
  knownNames: [],
  meetingContextEnabled: true,
  meetingCalendarEnabled: true,
  meetingMemoryEnabled: true,
  teamsAudioFallbackEnabled: true,
  hintsEnabled: false,
  wakeWordEnabled: true,
  askBeforeSendingEnabled: true,
  verboseLogging: true,
  toggleShortcut: "CommandOrControl+Shift+Space",
  toggleShortcutActive: true,
};

const VIEW: TeamsView = {
  relayConfigured: true,
  relayError: null,
  notice: null,
  me: { userId: "u-me", displayName: "Me Myself" },
  team: null,
  pendingInvite: null,
  detection: { inMeeting: true, raw: true, epoch: 1, source: "windows" },
  prompt: null,
  room: null,
  roster: [],
  merge: null,
  shareMuted: false,
};

// What Windows reports with the helper installed, in a Teams call where someone may not have Bee.
const LISTEN: TeamsAudioStatus = { platform: "windows", supported: true, reason: null, teamsCall: true, coverage: "uncovered", permission: "not-needed" };
// What a copy of Bee without the helper reports: no Teams-only capture here.
const NO_HELPER: TeamsAudioStatus = { platform: "windows", supported: false, reason: "helper-missing", teamsCall: false, coverage: "unknown", permission: "not-needed" };

/** A capture main started: lines() delivers text as main would, end() stops it from main's side. */
function fakeCapture() {
  let onLines: (texts: string[]) => void = () => undefined;
  let onEnd: Parameters<TeamsAudioCapture["start"]>[1] = () => undefined;
  const source: TeamsAudioCapture = {
    start: (lines, end) => {
      onLines = lines;
      onEnd = end;
    },
    stop: () => {
      capture.stopped += 1;
    },
  };
  const opened: TeamsAudioOpen = { capture: source, failure: null };
  return { opened, lines: (texts: string[]) => onLines(texts), end: (failure: Parameters<typeof onEnd>[0] = "no-teams") => onEnd(failure) };
}

async function loadStore(options: { settings?: Partial<SettingsView>; status?: TeamsAudioStatus } = {}) {
  const requests: PipelineRequest[] = [];
  const published: string[] = [];
  let teammates: TeamsTickResult["lines"] = [];
  let captions: (payload: MeetingWindowCaptions) => void = () => undefined;
  const audio = { status: options.status ?? LISTEN, screenRecordingAsked: 0 };
  let settings = { ...SETTINGS, ...options.settings };
  vi.stubGlobal("window", {
    bee: {
      getSettings: async () => settings,
      saveSettings: async (update: Partial<SettingsView>) => (settings = { ...settings, ...update }),
      mcp: { list: async () => [] },
      checkForUpdate: async () => ({ currentVersion: "0.0.0", latestVersion: null, available: false, error: null }),
      setWindowSize: async () => undefined,
      onLunaActivity: () => () => undefined,
      onLunaPartial: () => () => undefined,
      cancelPipeline: async () => undefined,
      runPipeline: async (request: PipelineRequest) => {
        requests.push(pipelineRequestSchema.parse(request));
        return EMPTY;
      },
      teams: {
        publish: async ({ text }: { text: string }) => published.push(text),
        tick: async (): Promise<TeamsTickResult> => {
          const lines = teammates;
          teammates = [];
          return { view: VIEW, lines };
        },
      },
      meetingWindow: {
        onCaptions: (listener: typeof captions) => {
          captions = listener;
          return () => undefined;
        },
      },
      teamsAudio: {
        status: async () => audio.status,
        openScreenRecordingSettings: async () => {
          audio.screenRecordingAsked += 1;
        },
      },
    },
  });
  const store = await import("./store");
  await vi.advanceTimersByTimeAsync(0);
  const teammate = async (text: string, clientTs = Date.now()) => {
    teammates = [{ id: `room:${clientTs}`, own: false, speakerId: "u-bob", speakerName: "Bob Jones", text, clientTs, serverTs: clientTs }];
    await vi.advanceTimersByTimeAsync(2000);
  };
  const caption = async (lines: MeetingWindowCaptions["lines"]) => {
    captions({ lines });
    await vi.advanceTimersByTimeAsync(1000);
  };
  const heard = async (text: string) => {
    store.actions.teamsAudioLines([text]);
    await vi.advanceTimersByTimeAsync(1000);
  };
  const said = (store: { getBeeState: () => { session: { lines: Array<{ own: boolean; speakerName: string; text: string }> } } }) =>
    store.getBeeState().session.lines.map((line) => (line.own ? line.text : `${line.speakerName}: ${line.text}`));
  // The status poll runs with the meeting tick, every 5 s.
  const poll = () => vi.advanceTimersByTimeAsync(5000);
  return { store, requests, published, teammate, caption, heard, said: () => said(store), poll, audio };
}

describe("store: Teams audio lines", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    sessions.length = 0;
    capture.open = async () => ({ capture: null, failure: "failed" });
    capture.opened = 0;
    capture.stopped = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("runs the pipeline on Teams audio as an unnamed speaker, and never shares it with the sync", async () => {
    const { store, requests, published, heard } = await loadStore({ status: NO_HELPER });
    await heard("When does SSO ship for enterprise customers?");
    expect(requests.at(-1)?.transcript).toEqual(["Meeting: When does SSO ship for enterprise customers?"]);
    expect(store.getBeeState().session.lines.map((line) => [line.own, line.speakerId])).toEqual([[false, "teams-audio"]]);
    expect(published).toEqual([]);
  });

  it("ignores Teams audio lines while the setting is off", async () => {
    const { store, requests, heard } = await loadStore({ settings: { teamsAudioFallbackEnabled: false } });
    await heard("When does SSO ship?");
    expect(requests).toEqual([]);
    expect(store.getBeeState().session.lines).toEqual([]);
  });

  it("drops Teams audio that repeats the user's own line, a teammate's Bee line or a caption", async () => {
    const { store, heard, teammate, caption, said } = await loadStore({ status: NO_HELPER });
    await store.actions.toggleMic();
    sessions.at(-1)?.onLine("we can offer fifteen percent off this quarter");
    await vi.advanceTimersByTimeAsync(1000);
    await teammate("does that include the support plan");
    await caption([{ speaker: "Priya Patel", text: "Can we get it signed by Friday?" }]);
    await heard("We can offer fifteen percent off this quarter.");
    await heard("Does that include the support plan?");
    await heard("Can we get it signed by Friday?");
    await heard("What about pricing next year?");
    expect(said()).toEqual([
      "we can offer fifteen percent off this quarter",
      "Bob Jones: does that include the support plan",
      "Priya Patel: Can we get it signed by Friday?",
      "Meeting: What about pricing next year?",
    ]);
  });

  it("lets a later teammate or caption line replace a Teams audio line, without a second run", async () => {
    const { requests, heard, teammate, caption, said } = await loadStore({ status: NO_HELPER });
    const spokenAt = Date.now();
    await heard("Does that include the support plan?");
    await heard("Let us check the roadmap first.");
    const runs = requests.length;
    await teammate("does that include the support plan", spokenAt);
    await caption([{ speaker: "Priya Patel", text: "Let's check the roadmap first." }]);
    expect(said()).toEqual(["Bob Jones: does that include the support plan", "Priya Patel: Let's check the roadmap first."]);
    expect(requests.length).toBe(runs);
  });
});

describe("store: Teams audio capture", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    sessions.length = 0;
    capture.open = async () => ({ capture: null, failure: "failed" });
    capture.opened = 0;
    capture.stopped = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("never opens a capture where Bee cannot hear Teams alone (here: no helper installed)", async () => {
    const { store, poll } = await loadStore({ status: NO_HELPER });
    await store.actions.toggleMic();
    await poll();
    expect(capture.opened).toBe(0);
    expect(store.getBeeState().teamsAudio).toEqual({ status: NO_HELPER, listening: false, failed: false, failure: null });
    expect(store.teamsAudioNow(store.getBeeState())).toBe("unavailable");
    expect(sessions).toHaveLength(1);
  });

  it("listens beside the mic: main sends text, never audio, and it stops when the mic goes off", async () => {
    const fake = fakeCapture();
    capture.open = async () => fake.opened;
    const { store, poll, published, said } = await loadStore();
    await store.actions.toggleMic();
    await poll();
    expect(capture.opened).toBe(1);
    expect(store.getBeeState().teamsAudio.listening).toBe(true);
    // Only the mic has a speech session here: Teams audio is segmented and transcribed in main, never mixed into the mic.
    expect(sessions).toHaveLength(1);
    fake.lines(["Can you send the contract today?"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(said()).toEqual(["Meeting: Can you send the contract today?"]);
    expect(published).toEqual([]);
    store.actions.stopMic(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(capture.stopped).toBe(1);
    expect(store.getBeeState().teamsAudio.listening).toBe(false);
  });

  it("does not listen until the mic is on, or while everyone has Bee, and stops when the setting goes off", async () => {
    const fake = fakeCapture();
    capture.open = async () => fake.opened;
    const { store, poll, audio } = await loadStore({ status: { ...LISTEN, coverage: "covered" } });
    await poll();
    expect(capture.opened).toBe(0);
    await store.actions.toggleMic();
    await poll();
    expect(capture.opened).toBe(0);
    expect(store.teamsAudioNow(store.getBeeState())).toBe("covered");
    audio.status = { ...LISTEN, coverage: "unknown" };
    await poll();
    expect(capture.opened).toBe(1);
    await store.actions.saveSettings({ teamsAudioFallbackEnabled: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(capture.stopped).toBe(1);
    expect(store.getBeeState().teamsAudio.listening).toBe(false);
  });

  it("fails open: a capture that will not open leaves the mic on and is not retried until the next call", async () => {
    capture.open = async () => {
      throw new Error("no handler");
    };
    const { store, poll, audio } = await loadStore();
    await store.actions.toggleMic();
    await poll();
    await poll();
    expect(capture.opened).toBe(1);
    expect(store.getBeeState().mic.on).toBe(true);
    expect(store.getBeeState().teamsAudio).toMatchObject({ listening: false, failed: true, failure: "failed" });
    audio.status = { ...LISTEN, teamsCall: false };
    await poll();
    expect(store.getBeeState().teamsAudio).toMatchObject({ failed: false, failure: null });
    audio.status = LISTEN;
    await poll();
    expect(capture.opened).toBe(2);
  });

  it("keeps main's reason when the helper will not start (no Teams app, denied, unsupported, missing)", async () => {
    for (const failure of ["no-teams", "denied", "unsupported", "missing"] as const) {
      vi.resetModules();
      capture.opened = 0;
      capture.open = async () => ({ capture: null, failure });
      const { store, poll } = await loadStore();
      await store.actions.toggleMic();
      await poll();
      await poll();
      expect(capture.opened).toBe(1);
      expect(store.getBeeState().teamsAudio).toMatchObject({ listening: false, failed: true, failure });
      expect(store.getBeeState().mic.on).toBe(true);
      store.actions.stopMic(null);
      vi.unstubAllGlobals();
    }
  });

  it("does not count main refusing to start (its status moved on) as a failure, and asks again on the next poll", async () => {
    capture.open = async () => ({ capture: null, failure: "refused" });
    const { store, poll } = await loadStore();
    await store.actions.toggleMic();
    await poll();
    expect(store.getBeeState().teamsAudio).toMatchObject({ listening: false, failed: false, failure: null });
    await poll();
    expect(capture.opened).toBe(2);
  });

  it("stops and does not reopen in this call when the helper fails (Teams closed)", async () => {
    const fake = fakeCapture();
    capture.open = async () => fake.opened;
    const { store, poll } = await loadStore();
    await store.actions.toggleMic();
    await poll();
    fake.end("no-teams");
    expect(store.getBeeState().teamsAudio).toMatchObject({ listening: false, failed: true, failure: "no-teams" });
    expect(capture.stopped).toBe(1);
    await poll();
    expect(capture.opened).toBe(1);
    expect(store.getBeeState().mic.on).toBe(true);
  });

  it("may start again after main stops it without a failure", async () => {
    const fake = fakeCapture();
    capture.open = async () => fake.opened;
    const { store, poll } = await loadStore();
    await store.actions.toggleMic();
    await poll();
    fake.end(null);
    expect(store.getBeeState().teamsAudio).toMatchObject({ listening: false, failed: false });
    await poll();
    expect(capture.opened).toBe(2);
    expect(store.getBeeState().teamsAudio.listening).toBe(true);
  });

  it("macOS: asking for Screen Recording clears a denied capture so the next poll tries again", async () => {
    capture.open = async () => ({ capture: null, failure: "denied" });
    const { store, poll, audio } = await loadStore({ status: { ...LISTEN, platform: "mac", permission: "unknown" } });
    await store.actions.toggleMic();
    await poll();
    expect(store.getBeeState().teamsAudio).toMatchObject({ failed: true, failure: "denied" });
    await store.actions.openScreenRecordingSettings();
    expect(audio.screenRecordingAsked).toBe(1);
    expect(store.getBeeState().teamsAudio).toMatchObject({ failed: false, failure: null });
    await poll();
    expect(capture.opened).toBe(2);
  });
});
