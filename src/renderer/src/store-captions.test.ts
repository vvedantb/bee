import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pipelineRequestSchema, type MeetingWindowCaptions, type PipelineRequest, type PipelineResult, type SettingsView } from "../../shared/ipc";
import type { startMicSession } from "./speech";

// Live captions from the experimental meeting window reader reach the same pipeline as spoken lines, labelled by speaker.
// Preload (window.bee), Clerk, the mic and speech-to-text are stubbed, as in store.test.ts.
type MicArgs = Parameters<typeof startMicSession>[0];

const micSessions: MicArgs[] = [];
vi.mock("@clerk/electron/react", () => ({ getToken: async () => "token" }));
vi.mock("./mic", () => ({
  openMic: async () => ({ sampleRate: 48_000, start: () => undefined, stop: () => undefined }),
}));
vi.mock("./speech", () => ({
  startMicSession: (args: MicArgs) => {
    micSessions.push(args);
    return { push: () => 0, stop: async () => undefined };
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
  autoMeetingDetection: false,
  interfaceScale: 1,
  motionPreference: "on",
  secretStorage: "os",
  notesDir: "/notes",
  logsDir: "/logs",
  knownNames: [],
  teamsAudioFallbackEnabled: true,
  toggleShortcut: "CommandOrControl+Shift+Space",
  toggleShortcutActive: true,
};

async function loadStore(settings: Partial<SettingsView> = {}) {
  const requests: PipelineRequest[] = [];
  const published: string[] = [];
  let captions: (payload: MeetingWindowCaptions) => void = () => undefined;
  vi.stubGlobal("window", {
    bee: {
      getSettings: async () => ({ ...SETTINGS, ...settings }),
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
      teams: { publish: async ({ text }: { text: string }) => published.push(text) },
      meetingWindow: {
        onCaptions: (listener: typeof captions) => {
          captions = listener;
          return () => undefined;
        },
      },
    },
  });
  const store = await import("./store");
  await vi.advanceTimersByTimeAsync(0);
  const send = async (lines: MeetingWindowCaptions["lines"]) => {
    captions({ lines });
    await vi.advanceTimersByTimeAsync(1000);
  };
  return { store, send, requests, published };
}

describe("store: live captions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    micSessions.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("runs the pipeline on caption lines, labelled by speaker, and keeps them for the summary", async () => {
    const { store, send, requests, published } = await loadStore();
    await send([
      { speaker: "Priya Patel", text: "When does SSO ship for enterprise customers?" },
      { speaker: null, text: "Let's check the roadmap." },
    ]);
    expect(requests.at(-1)?.transcript).toEqual(["Priya Patel: When does SSO ship for enterprise customers?", "Meeting: Let's check the roadmap."]);
    expect(store.getBeeState().session.lines.map((line) => line.own)).toEqual([false, false]);
    // Captions are never shared with a Teams sync.
    expect(published).toEqual([]);
  });

  it("drops a caption of the user's own mic line while the mic is on, and keeps other speakers", async () => {
    const { store, send, requests } = await loadStore();
    await store.actions.toggleMic();
    const mic = micSessions.at(-1);
    mic?.onLine("we can offer fifteen percent off this quarter");
    await vi.advanceTimersByTimeAsync(1000);
    await send([
      { speaker: "Sam Lee", text: "We can offer fifteen percent off this quarter." },
      { speaker: "Bob Jones", text: "Does that include the support plan?" },
    ]);
    const lines = store.getBeeState().session.lines.map((line) => (line.own ? line.text : `${line.speakerName}: ${line.text}`));
    expect(lines).toEqual(["we can offer fifteen percent off this quarter", "Bob Jones: Does that include the support plan?"]);
    expect(requests.at(-1)?.transcript.at(-1)).toBe("Bob Jones: Does that include the support plan?");
  });
});
