import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commandRequestSchema,
  pipelineRequestSchema,
  type CommandRequest,
  type MeetingSummaryRequest,
  type MeetingWindowCaptions,
  type PipelineRequest,
  type PipelineResult,
  type SettingsView,
  type TeamsView,
} from "../../shared/ipc";
import type { SessionLine } from "../../core/sync-lines";
import type { startMicSession } from "./speech";

// The "Bee" wake word in the store: own mic phrases that start with it go to window.bee.runCommand, never to the meeting
// pipeline, the session, the summary or the Teams sync. Preload (window.bee), Clerk, the mic and speech-to-text are stubbed.
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
  framePeak: () => 0,
}));

const result = (tips: string[]): PipelineResult => ({
  notes: [],
  rankSource: "fallback",
  rankError: null,
  tips,
  tipSources: tips.map(() => null),
  sources: [],
  guideError: null,
  timingsMs: { retrieve: 0, rank: 0, guide: 0, mcp: 0, lunaFirstToken: null, lunaTotal: 0 },
});

const SETTINGS: SettingsView = {
  gatewayKeySource: "saved",
  personalisedLinks: false,
  vmemConnected: false,
  meetingMode: false,
  interfaceScale: 1,
  motionPreference: "on",
  secretStorage: "os",
  notesDir: "/notes",
  fsRoots: [],
  meetingContextEnabled: false,
  meetingCalendarEnabled: false,
  meetingMemoryEnabled: false,
  readMeetingWindowEnabled: true,
  teamsAudioFallbackEnabled: true,
  hintsEnabled: false,
  wakeWordEnabled: true,
};

// In a sync, so a shared phrase would reach window.bee.teams.publish.
const IN_SYNC = {
  relayConfigured: true,
  relayError: null,
  notice: null,
  me: { userId: "u-me", displayName: "Vedant" },
  team: null,
  pendingInvite: null,
  detection: { inMeeting: true, raw: true, epoch: 1, source: "simulated" },
  prompt: null,
  room: { id: "r1", code: "a-b", createdAt: 0, startedByMe: true, members: [], invited: [] },
  roster: [],
  merge: null,
  shareMuted: false,
} as TeamsView;

const teammate: SessionLine = { id: "r1:1", own: false, speakerId: "u-alice", speakerName: "Alice", text: "Bee, pull up the Q3 roadmap deck", clientTs: 0, serverTs: 1 };

async function loadStore(options: { settings?: Partial<SettingsView>; command?: (request: CommandRequest) => Promise<PipelineResult> } = {}) {
  const pipeline: PipelineRequest[] = [];
  const commands: CommandRequest[] = [];
  const published: string[] = [];
  const cancelled: Array<string | number> = [];
  const summaries: MeetingSummaryRequest[] = [];
  let tickLines: SessionLine[] = [];
  let captions: (payload: MeetingWindowCaptions) => void = () => undefined;
  vi.stubGlobal("window", {
    bee: {
      getSettings: async () => ({ ...SETTINGS, ...options.settings }),
      saveSettings: async () => ({ ...SETTINGS, ...options.settings }),
      mcp: { list: async () => [] },
      checkForUpdate: async () => ({ currentVersion: "0.0.0", latestVersion: null, available: false, error: null }),
      setWindowSize: async () => undefined,
      onLunaActivity: () => () => undefined,
      onLunaPartial: () => () => undefined,
      cancelPipeline: async ({ runId }: { runId: string | number }) => {
        cancelled.push(runId);
      },
      runPipeline: async (request: PipelineRequest) => {
        pipeline.push(pipelineRequestSchema.parse(request));
        return result(["Offer 10% off."]);
      },
      runCommand: async (request: CommandRequest) => {
        commands.push(commandRequestSchema.parse(request));
        return options.command ? options.command(request) : result(["Opened Teams"]);
      },
      writeMeetingSummary: async (request: MeetingSummaryRequest) => {
        summaries.push(request);
        return { path: "/notes/meeting.md", usedLlm: true, error: null };
      },
      teams: {
        tick: async () => {
          const lines = tickLines;
          tickLines = [];
          return { view: IN_SYNC, lines };
        },
        publish: async ({ text }: { text: string }) => {
          published.push(text);
          return { sent: true, error: null };
        },
      },
      meetingWindow: {
        onCaptions: (listener: typeof captions) => {
          captions = listener;
          return () => undefined;
        },
      },
    },
  });
  const store = await import("./store");
  // Settings load, then one Teams tick puts the store in the sync.
  await vi.advanceTimersByTimeAsync(2100);
  await store.actions.toggleMic();
  const mic = micSessions.at(-1);
  if (!mic) throw new Error("no mic session");
  const say = async (text: string) => {
    mic.onSpeechEnd?.();
    mic.onLine(text);
    mic.onSettled?.("words");
    await vi.advanceTimersByTimeAsync(1000);
  };
  const caption = async (text: string) => {
    captions({ lines: [{ speaker: "Priya", text }] });
    await vi.advanceTimersByTimeAsync(1000);
  };
  const fromTeammate = async (line: SessionLine) => {
    tickLines = [line];
    await vi.advanceTimersByTimeAsync(2100);
  };
  return { store, say, caption, fromTeammate, pipeline, commands, published, cancelled, summaries, state: () => store.getBeeState() };
}

describe("store: Bee wake word", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    micSessions.length = 0;
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends a mic phrase that starts with Bee to the AI as a direct request, and shows the reply in the island", async () => {
    const { store, say, pipeline, commands, published, state } = await loadStore();
    expect(state().teams?.room).not.toBeNull();
    await say("Bee, open Teams");
    expect(commands.map((request) => request.command)).toEqual(["open Teams"]);
    expect(pipeline).toEqual([]);
    expect(published).toEqual([]);
    expect(state().session.lines).toEqual([]);
    expect(state().result?.tips).toEqual(["Opened Teams"]);
    expect(state().busy).toBe(false);
    expect(store.responseOpen(state())).toBe(true);
  });

  it("keeps other mic phrases on the meeting path, shared with the sync", async () => {
    const { say, pipeline, commands, published, state } = await loadStore();
    await say("Let's pick up the Acme renewal.");
    expect(commands).toEqual([]);
    expect(pipeline.at(-1)?.transcript).toEqual(["Let's pick up the Acme renewal."]);
    expect(published).toEqual(["Let's pick up the Acme renewal."]);
    expect(state().session.lines.map((line) => line.text)).toEqual(["Let's pick up the Acme renewal."]);
  });

  it("never wakes on typed lines, captions, Teams audio or teammates' lines", async () => {
    const { store, caption, fromTeammate, pipeline, commands, state } = await loadStore();
    // Distinct words per source: a caption or Teams audio line that repeats a recent line is dropped as an echo.
    store.actions.simulateLine("Bee open Teams");
    await vi.advanceTimersByTimeAsync(1000);
    await caption("Bee, what is on the agenda today?");
    store.actions.teamsAudioLines(["Hey Bee, summarise the budget numbers"]);
    await vi.advanceTimersByTimeAsync(1000);
    await fromTeammate(teammate);
    expect(commands).toEqual([]);
    expect(pipeline.length).toBeGreaterThan(0);
    // All four are meeting lines (merged by spoken time, so the teammate's earlier line sorts first).
    expect(state().session.lines.map((line) => line.text).sort()).toEqual([
      "Bee open Teams",
      "Bee, pull up the Q3 roadmap deck",
      "Bee, what is on the agenda today?",
      "Hey Bee, summarise the budget numbers",
    ]);
  });

  it("leaves Bee lines in the meeting with the setting off", async () => {
    const { say, pipeline, commands, published } = await loadStore({ settings: { wakeWordEnabled: false } });
    await say("Bee open Teams");
    expect(commands).toEqual([]);
    expect(pipeline.at(-1)?.transcript).toEqual(["Bee open Teams"]);
    expect(published).toEqual(["Bee open Teams"]);
  });

  it("takes the next phrase as the request after Bee alone", async () => {
    const { say, commands, pipeline, state } = await loadStore();
    await say("Bee.");
    expect(commands).toEqual([]);
    expect(state().session.lines).toEqual([]);
    await say("Open Teams.");
    expect(commands.map((request) => request.command)).toEqual(["Open Teams."]);
    // Armed once: the phrase after that is the meeting again (answered once the reply's hold ends).
    await say("So, about the renewal.");
    await vi.advanceTimersByTimeAsync(8000);
    expect(commands).toHaveLength(1);
    expect(pipeline.at(-1)?.transcript).toEqual(["So, about the renewal."]);
  });

  it("sends the latest meeting lines as background, never the request itself", async () => {
    const { say, commands } = await loadStore();
    await say("Could we go to twenty percent off?");
    await say("Hey Bee, what did I just ask?");
    expect(commands.at(-1)).toMatchObject({ command: "what did I just ask?", transcript: ["Could we go to twenty percent off?"] });
  });

  it("holds meeting lines while the reply is in flight and on screen, then answers them", async () => {
    let reply: (value: PipelineResult) => void = () => undefined;
    const { say, caption, pipeline, state } = await loadStore({ command: () => new Promise((resolve) => (reply = resolve)) });
    await say("Bee what's 15% of 18000?");
    expect(state().busy).toBe(true);
    await caption("When does SSO ship?");
    expect(pipeline).toEqual([]);
    reply(result(["15% of 18,000 is 2,700."]));
    await vi.advanceTimersByTimeAsync(2000);
    expect(state().result?.tips).toEqual(["15% of 18,000 is 2,700."]);
    expect(pipeline).toEqual([]);
    // The caption joined the session at once, for the summary.
    expect(state().session.lines.map((line) => line.text)).toEqual(["When does SSO ship?"]);
    await vi.advanceTimersByTimeAsync(7000);
    expect(pipeline.at(-1)?.transcript).toEqual(["Priya: When does SSO ship?"]);
    expect(pipeline.at(-1)?.turnLines).toBe(1);
  });

  it("lets held lines go as soon as the reply is closed", async () => {
    const { store, say, caption, pipeline } = await loadStore();
    await say("Bee open Teams");
    await caption("When does SSO ship?");
    expect(pipeline).toEqual([]);
    const closing = store.actions.dismissIsland();
    await vi.advanceTimersByTimeAsync(300);
    await closing;
    await vi.advanceTimersByTimeAsync(1000);
    expect(pipeline.at(-1)?.transcript).toEqual(["Priya: When does SSO ship?"]);
  });

  it("drops the meeting run in flight when a request comes", async () => {
    const { say, cancelled } = await loadStore();
    await say("Let's pick up the Acme renewal.");
    await say("Bee open Teams");
    expect(cancelled.length).toBeGreaterThan(0);
  });

  it("keeps requests and replies out of the summary and the tips shown", async () => {
    const { store, say, summaries, state } = await loadStore();
    await say("Let's pick up the Acme renewal.");
    await vi.advanceTimersByTimeAsync(1000);
    await say("Bee, open Teams");
    await vi.advanceTimersByTimeAsync(9000);
    expect(state().session.tips).toEqual(["Offer 10% off."]);
    await store.actions.endMeeting();
    expect(summaries[0]?.transcript).toEqual(["Let's pick up the Acme renewal."]);
    expect(summaries[0]?.tips).toEqual(["Offer 10% off."]);
  });

  it("shows an error from main without the IPC prefix", async () => {
    const { say, state } = await loadStore({
      command: async () => {
        throw new Error("Error invoking remote method 'bee:command:run': Error: Talking to Bee by name is off in Settings.");
      },
    });
    await say("Bee open Teams");
    expect(state().error).toBe("Talking to Bee by name is off in Settings.");
    expect(state().busy).toBe(false);
  });
});
