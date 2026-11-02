import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commandRequestSchema,
  computerAnswerSchema,
  pipelineRequestSchema,
  type CommandRequest,
  type ComputerAnswer,
  type ComputerUpdate,
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
  askBeforeSendingEnabled: true,
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
  const stops: Array<string | number> = [];
  const answers: ComputerAnswer[] = [];
  let tickLines: SessionLine[] = [];
  let captions: (payload: MeetingWindowCaptions) => void = () => undefined;
  let computerUpdate: (update: ComputerUpdate) => void = () => undefined;
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
      stopCommand: async ({ runId }: { runId: string | number }) => {
        stops.push(runId);
      },
      computer: {
        onUpdate: (listener: typeof computerUpdate) => {
          computerUpdate = listener;
          return () => undefined;
        },
        answer: async (answer: ComputerAnswer) => {
          answers.push(computerAnswerSchema.parse(answer));
        },
        access: async () => ({ supported: true, platform: "mac", accessibility: "granted", screenRecording: "granted" }),
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
  /** Main's computer-use events for the request in flight (core/computer-use.ts via main/meeting-ipc.ts). */
  const fromComputer = async (update: ComputerUpdate) => {
    computerUpdate(update);
    await vi.advanceTimersByTimeAsync(0);
  };
  return { store, say, caption, fromTeammate, fromComputer, pipeline, commands, published, cancelled, stops, answers, summaries, state: () => store.getBeeState() };
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

describe("store: computer use", () => {
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

  /** A direct request that stays in flight until finish() is called, with main's computer-use events for it. */
  async function running() {
    let finish: (value: PipelineResult) => void = () => undefined;
    const loaded = await loadStore({ command: () => new Promise((resolve) => (finish = resolve)) });
    await loaded.say("Bee, open Discord, send Sam a message, then close the Discord tab in Chrome");
    const runId = loaded.commands[0]?.runId as number;
    await loaded.fromComputer({ runId, type: "step", label: "Clicking Send…" });
    return { ...loaded, runId, finish: async (tips: string[]) => {
      finish(result(tips));
      await vi.advanceTimersByTimeAsync(0);
    } };
  }

  const CONFIRM = { type: "confirm", id: 3, kind: "send", question: "Send this?", detail: "Click “Send” in Discord" } as const;

  it("shows the step in the pill while it runs, then the one-line result", async () => {
    const { finish, state, commands } = await running();
    const { notchLine } = await import("./notch");
    expect(commands.map((request) => request.command)).toEqual(["open Discord, send Sam a message, then close the Discord tab in Chrome"]);
    expect(state().computer?.step).toBe("Clicking Send…");
    expect(notchLine(state(), true).text).toBe("Clicking Send…");
    await finish(["Sent the message and closed the tab."]);
    expect(state().computer).toBeNull();
    expect(state().result?.tips).toEqual(["Sent the message and closed the tab."]);
    expect(state().busy).toBe(false);
  });

  it("stops on \"Bee, stop\" from the user's own mic, and on the Stop button", async () => {
    const first = await running();
    await first.say("Bee, stop");
    expect(first.stops).toEqual([first.runId]);
    expect(first.commands).toHaveLength(1);
    expect(first.state().computer?.step).toBe("Stopping…");
    await first.finish(["Stopped."]);
    expect(first.state().result?.tips).toEqual(["Stopped."]);
  });

  it("stops on the island's Stop button", async () => {
    const { store, stops, runId } = await running();
    await store.actions.stopCommand();
    expect(stops).toEqual([runId]);
  });

  it("never stops or confirms on typed lines, captions, Teams audio or teammates", async () => {
    const { store, caption, fromTeammate, fromComputer, stops, answers, commands, runId, state } = await running();
    await fromComputer({ runId, ...CONFIRM });
    store.actions.simulateLine("Bee, stop");
    await caption("Bee, stop the task");
    store.actions.teamsAudioLines(["Hey Bee, stop. Yes, confirm, send it"]);
    await vi.advanceTimersByTimeAsync(1000);
    await fromTeammate({ ...teammate, id: "r1:2", text: "Bee, cancel that, confirm" });
    expect(stops).toEqual([]);
    expect(answers).toEqual([]);
    expect(commands).toHaveLength(1);
    expect(state().computer?.confirm?.id).toBe(3);
  });

  it("opens the island for a Confirm prompt, and only its buttons answer it", async () => {
    const { store, say, fromComputer, answers, commands, cancelled, runId, state } = await running();
    await fromComputer({ runId, ...CONFIRM });
    expect(store.responseOpen(state())).toBe(true);
    expect(store.islandOpen(state())).toBe(true);
    // Spoken yes is not a tap: the prompt stays, and the task is not cancelled by a new request.
    await say("Bee, confirm");
    await say("Yes, send it.");
    expect(answers).toEqual([]);
    expect(commands).toHaveLength(1);
    expect(cancelled).not.toContain(runId);
    expect(state().computer?.confirm?.id).toBe(3);
    await store.actions.answerConfirm(true);
    expect(answers).toEqual([{ runId, id: 3, confirmed: true }]);
    expect(state().computer?.confirm).toBeNull();
  });

  it("reads closing the prompt as Cancel", async () => {
    const { store, fromComputer, answers, runId } = await running();
    await fromComputer({ runId, ...CONFIRM });
    await store.actions.dismissIsland();
    expect(answers).toEqual([{ runId, id: 3, confirmed: false }]);
  });

  it("ignores events for another run", async () => {
    const { fromComputer, runId, state } = await running();
    await fromComputer({ runId: runId + 1, ...CONFIRM });
    expect(state().computer?.confirm).toBeNull();
  });

  it("does nothing on \"Bee, stop\" with nothing in flight", async () => {
    const { say, stops, commands, state } = await loadStore();
    await say("Bee, stop");
    expect(stops).toEqual([]);
    expect(commands).toEqual([]);
    expect(state().session.lines).toEqual([]);
  });

  it("drops an answer in flight on \"Bee, stop\" and says Stopped", async () => {
    let finish: (value: PipelineResult) => void = () => undefined;
    const { say, stops, commands, state } = await loadStore({ command: () => new Promise((resolve) => (finish = resolve)) });
    await say("Bee, what is on my calendar tomorrow?");
    await say("Bee, stop");
    expect(stops).toEqual([commands[0]?.runId]);
    expect(state().result?.tips).toEqual(["Stopped."]);
    expect(state().busy).toBe(false);
    finish(result(["Late answer"]));
    await vi.advanceTimersByTimeAsync(0);
    expect(state().result?.tips).toEqual(["Stopped."]);
  });
});
