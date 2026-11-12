import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commandRequestSchema,
  computerAnswerSchema,
  conversationEndedSchema,
  pipelineRequestSchema,
  type ConversationEnded,
  type CommandRequest,
  type FollowUpRequest,
  type FollowUpResult,
  type ComputerAnswer,
  type ComputerUpdate,
  type MeetingSummaryRequest,
  type MeetingWindowCaptions,
  type PipelineRequest,
  type PipelineResult,
  type SettingsView,
} from "../../shared/ipc";
import type { startMicSession } from "./speech";
import { REOPEN_WINDOW_MS } from "../../core/wake-word";

// Phrase ids for lines the stubbed mic session hands over (core/speech.ts PhraseLine).
let phraseSeq = 0;
const nextPhrase = () => (phraseSeq += 1);

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
  sendSessionsToVmem: false,
  meetingMode: false,
  autoMeetingDetection: false,
  allowRemoteAi: false,
  interfaceScale: 1,
  motionPreference: "on",
  secretStorage: "os",
  notesDir: "/notes",
  logsDir: "/logs",
  knownNames: [],
  teamsAudioFallbackEnabled: true,
  toggleShortcut: "CommandOrControl+Shift+Space",
  toggleShortcutActive: true,
  askShortcut: "CommandOrControl+Alt+Space",
  askShortcutActive: true,
};

// Another speaker, heard as a live caption from the call window.
const teammate = { speaker: "Alice", text: "Bee, pull up the Q3 roadmap deck" };

async function loadStore(
  options: { settings?: Partial<SettingsView>; command?: (request: CommandRequest) => Promise<PipelineResult>; classify?: (request: FollowUpRequest) => Promise<FollowUpResult> } = {},
) {
  const pipeline: PipelineRequest[] = [];
  const commands: CommandRequest[] = [];
  const cancelled: Array<string | number> = [];
  const summaries: MeetingSummaryRequest[] = [];
  const stops: Array<string | number> = [];
  const answers: ComputerAnswer[] = [];
  const ended: ConversationEnded[] = [];
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
      // Only when the test gives one: without it, an unclear phrase in the conversation window stays a meeting line.
      ...(options.classify ? { classifyFollowUp: options.classify } : {}),
      runCommand: async (request: CommandRequest) => {
        commands.push(commandRequestSchema.parse(request));
        return options.command ? options.command(request) : result(["Opened Teams"]);
      },
      conversationEnded: async (request: ConversationEnded) => {
        ended.push(conversationEndedSchema.parse(request));
      },
      writeMeetingSummary: async (request: MeetingSummaryRequest) => {
        summaries.push(request);
        return { path: "/notes/meeting.md", usedLlm: true, error: null, followUp: [] };
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
  await vi.advanceTimersByTimeAsync(2100);
  await store.actions.toggleMic();
  const mic = micSessions.at(-1);
  if (!mic) throw new Error("no mic session");
  const say = async (text: string) => {
    mic.onSpeechEnd?.();
    mic.onLine({ id: nextPhrase(), text, final: true });
    mic.onSettled?.("words");
    await vi.advanceTimersByTimeAsync(1000);
  };
  const caption = async (text: string) => {
    captions({ lines: [{ speaker: "Priya", text }] });
    await vi.advanceTimersByTimeAsync(1000);
  };
  const fromTeammate = async (line: { speaker: string; text: string }) => {
    captions({ lines: [line] });
    await vi.advanceTimersByTimeAsync(1000);
  };
  /** Main's computer-use events for the request in flight (core/computer-use.ts via main/meeting-ipc.ts). */
  const fromComputer = async (update: ComputerUpdate) => {
    computerUpdate(update);
    await vi.advanceTimersByTimeAsync(0);
  };
  return { store, say, caption, fromTeammate, fromComputer, pipeline, commands, cancelled, stops, answers, summaries, ended, state: () => store.getBeeState() };
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
    const { store, say, pipeline, commands, state } = await loadStore();
    await say("Bee, open Teams");
    expect(commands.map((request) => request.command)).toEqual(["open Teams"]);
    expect(pipeline).toEqual([]);
    expect(state().session.lines).toEqual([]);
    expect(state().result?.tips).toEqual(["Opened Teams"]);
    expect(state().busy).toBe(false);
    expect(store.responseOpen(state())).toBe(true);
  });

  it("runs a typed request from the typing box like one said after Bee, and closes the box", async () => {
    const { store, commands, pipeline, state } = await loadStore();
    store.actions.openAsk();
    expect(state().asking).toBe(true);
    expect(store.responseOpen(state())).toBe(true);
    store.actions.submitAsk("Bee, open Teams");
    await vi.waitFor(() => expect(state().result?.tips).toEqual(["Opened Teams"]));
    expect(commands.map((request) => request.command)).toEqual(["open Teams"]);
    expect(pipeline).toEqual([]);
    expect(state().asking).toBe(false);
    store.actions.openAsk();
    store.actions.submitAsk("   ");
    expect(state().asking).toBe(false);
    expect(commands).toHaveLength(1);
  });

  it("keeps other mic phrases on the meeting path, shared with the sync", async () => {
    const { say, pipeline, commands, state } = await loadStore();
    await say("Let's pick up the Acme renewal.");
    expect(commands).toEqual([]);
    expect(pipeline.at(-1)?.transcript).toEqual(["Let's pick up the Acme renewal."]);
    expect(state().session.lines.map((line) => line.text)).toEqual(["Let's pick up the Acme renewal."]);
  });

  it("never wakes on typed lines, captions or Teams audio", async () => {
    const { store, caption, fromTeammate, pipeline, commands, state } = await loadStore();
    // Distinct words per source: a caption or Teams audio line that repeats a recent line is dropped as an echo.
    store.actions.simulateLine("Bee open Teams");
    await vi.advanceTimersByTimeAsync(1000);
    await caption("Bee, what is on the agenda today?");
    store.actions.teamsAudioLines([{ id: nextPhrase(), text: "Hey Bee, summarise the budget numbers", final: true }]);
    await vi.advanceTimersByTimeAsync(1000);
    await fromTeammate(teammate);
    expect(commands).toEqual([]);
    expect(pipeline.length).toBeGreaterThan(0);
    // All four are meeting lines.
    expect(state().session.lines.map((line) => line.text).sort()).toEqual([
      "Bee open Teams",
      "Bee, pull up the Q3 roadmap deck",
      "Bee, what is on the agenda today?",
      "Hey Bee, summarise the budget numbers",
    ]);
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

  it("never stops or confirms on typed lines, captions or Teams audio", async () => {
    const { store, caption, fromTeammate, fromComputer, stops, answers, commands, runId, state } = await running();
    await fromComputer({ runId, ...CONFIRM });
    store.actions.simulateLine("Bee, stop");
    await caption("Bee, stop the task");
    store.actions.teamsAudioLines([{ id: nextPhrase(), text: "Hey Bee, stop. Yes, confirm, send it", final: true }]);
    await vi.advanceTimersByTimeAsync(1000);
    await fromTeammate({ ...teammate, text: "Bee, cancel that, confirm" });
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

describe("store: Bee's history and the conversation window", () => {
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

  const USAGE_URL = "Opened https://vercel.com/acme/~/usage";
  const opened = async (request: CommandRequest) =>
    request.command === "open Vercel usage" ? { ...result([USAGE_URL]), actions: [USAGE_URL] } : result([`Reply to ${request.command}`]);

  it("never sends a history: main keeps Bee's whole history and sends it to the AI", async () => {
    const { say, commands } = await loadStore({ command: opened });
    await say("B, open Vercel usage");
    await say("Bee, open the team usage");
    expect(commands.map((request) => Object.keys(request).includes("history"))).toEqual([false, false]);
    expect(commands[1]).toMatchObject({ command: "open the team usage" });
    expect(commands[1]?.transcript).toBeUndefined();
  });

  it("keeps every exchange of the conversation for vmem: no turn cap", async () => {
    const { say, store } = await loadStore();
    for (let index = 1; index <= 8; index++) await say(`Bee, what is ${index} plus ${index}?`);
    expect(store.beeConversation().map((item) => item.request)).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((index) => `what is ${index} plus ${index}?`));
  });

  it("ends the conversation for vmem after ten idle minutes, which never touches the AI's history", async () => {
    const { say, commands, store } = await loadStore();
    await say("Bee, open Teams");
    expect(store.beeConversation()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(store.beeConversation()).toEqual([]);
    await say("Bee, open Slack");
    expect(commands.at(-1)).not.toHaveProperty("history");
  });

  it("sends the finished conversation to main after ten idle minutes, with the setting on", async () => {
    const { say, ended } = await loadStore({ command: opened, settings: { sendSessionsToVmem: true } });
    await say("Bee, open Vercel usage");
    await say("Bee, open the team usage");
    expect(ended).toEqual([]);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(ended).toHaveLength(1);
    expect(ended[0]?.exchanges.map((exchange) => exchange.request)).toEqual(["open Vercel usage", "open the team usage"]);
  });

  it("sends nothing with the setting off, or when the meeting ends", async () => {
    const off = await loadStore();
    await off.say("Bee, open Teams");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(off.ended).toEqual([]);
    vi.resetModules();
    const on = await loadStore({ settings: { sendSessionsToVmem: true } });
    await on.say("Let's pick up the Acme renewal.");
    await on.say("Bee, open Teams");
    await on.store.actions.endMeeting();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(on.ended).toEqual([]);
  });

  it("ends the conversation for vmem and closes the window when the meeting ends", async () => {
    const { say, store, state } = await loadStore();
    await say("Let's pick up the Acme renewal.");
    await say("Bee, open Teams");
    expect(state().conversationOpen).toBe(true);
    await store.actions.endMeeting();
    expect(store.beeConversation()).toEqual([]);
    expect(state().conversationOpen).toBe(false);
  });

  it("takes a follow-up without Bee in the window, and keeps it out of the meeting", async () => {
    const { say, commands, pipeline, state } = await loadStore({ command: opened });
    await say("B, open Vercel usage");
    expect(state().conversationOpen).toBe(true);
    const { notchLine, CONVERSATION_LABEL } = await import("./notch");
    expect(notchLine(state(), true).text).toBe(CONVERSATION_LABEL);
    await say("Why do you not go to the team usage?");
    expect(commands.map((request) => request.command)).toEqual(["open Vercel usage", "Why do you not go to the team usage?"]);
    expect(state().session.lines).toEqual([]);
    expect(pipeline).toEqual([]);
  });

  it("closes the window after a minute of silence", async () => {
    const { say, commands, state } = await loadStore();
    await say("Bee, open Teams");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(state().conversationOpen).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(state().conversationOpen).toBe(false);
    await say("why did you open that");
    expect(commands).toHaveLength(1);
    expect(state().session.lines.map((line) => line.text)).toEqual(["why did you open that"]);
  });

  it("holds the window open while Bee's reply asks a question", async () => {
    const { say, commands, state } = await loadStore({ command: async (request) => result([request.command === "open the team usage" ? "Which team?" : "Opened the Acme team usage."]) });
    await say("Bee, open the team usage");
    await vi.advanceTimersByTimeAsync(90_000);
    expect(state().conversationOpen).toBe(true);
    await say("Acme platform");
    expect(commands.map((request) => request.command)).toEqual(["open the team usage", "Acme platform"]);
  });

  it("never opens the window or runs a request for other people's lines", async () => {
    const { store, say, caption, fromTeammate, commands, state } = await loadStore();
    await caption("Why did you open that page?");
    store.actions.teamsAudioLines([{ id: nextPhrase(), text: "No, the team one", final: true }]);
    await fromTeammate({ ...teammate, text: "Can you check the billing tab?" });
    expect(commands).toEqual([]);
    expect(state().conversationOpen).toBe(false);
    // In the window too: only the user's own mic reaches Bee.
    await say("Bee, open Teams");
    await caption("Why did you open that page?");
    store.actions.teamsAudioLines([{ id: nextPhrase(), text: "Go back to that page", final: true }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(commands).toHaveLength(1);
  });

  it("closes the window when the user replies to someone else, or names them", async () => {
    const first = await loadStore();
    await first.say("Bee, open Teams");
    await first.caption("Should we ship on Friday?");
    await first.say("I think Friday works for the release.");
    expect(first.state().conversationOpen).toBe(false);
    expect(first.commands).toHaveLength(1);

    vi.resetModules();
    const second = await loadStore();
    await second.caption("Morning all.");
    await second.say("Bee, open Teams");
    await second.say("Priya, could you share the deck?");
    expect(second.state().conversationOpen).toBe(false);
    expect(second.commands).toHaveLength(1);
    expect(second.state().session.lines.map((line) => line.text)).toContain("Priya, could you share the deck?");
  });

  it("closes on thanks, on stop, and when the island is dismissed", async () => {
    const thanks = await loadStore();
    await thanks.say("Bee, open Teams");
    await thanks.say("Thanks!");
    expect(thanks.state().conversationOpen).toBe(false);
    expect(thanks.state().session.lines).toEqual([]);
    expect(thanks.commands).toHaveLength(1);

    vi.resetModules();
    const stop = await loadStore();
    await stop.say("Bee, open Teams");
    await stop.say("Stop.");
    expect(stop.state().conversationOpen).toBe(false);

    vi.resetModules();
    const dismissed = await loadStore();
    await dismissed.say("Bee, open Teams");
    const closing = dismissed.store.actions.dismissIsland();
    await vi.advanceTimersByTimeAsync(300);
    await closing;
    expect(dismissed.state().conversationOpen).toBe(false);
  });

  it("asks the classifier once for an unclear phrase, and acts only on bee at 0.7 or more", async () => {
    const asked: FollowUpRequest[] = [];
    let verdict: FollowUpResult = { addressed: "bee", confidence: 0.9 };
    const { say, commands, state } = await loadStore({
      classify: async (request) => {
        asked.push(request);
        return verdict;
      },
    });
    await say("Bee, open the Vercel dashboard");
    await say("The billing numbers look off this month.");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ phrase: "The billing numbers look off this month.", lastBee: { request: "open the Vercel dashboard" }, othersQuiet: true });
    expect(commands.map((request) => request.command)).toEqual(["open the Vercel dashboard", "The billing numbers look off this month."]);
    verdict = { addressed: "bee", confidence: 0.5 };
    await say("Revenue is flat this quarter.");
    expect(asked).toHaveLength(2);
    expect(commands).toHaveLength(2);
    expect(state().session.lines.map((line) => line.text)).toEqual(["Revenue is flat this quarter."]);
  });

  it("shows a fallback line for a reply with no lines and no error", async () => {
    const { say, state, store } = await loadStore({ command: async () => result([]) });
    await say("Bee, open the team one");
    expect(state().result?.tips).toEqual(["Which one?"]);
    expect(store.beeConversation()[0]).toMatchObject({ request: "open the team one", reply: "Which one?" });
  });

  it("takes yes to Bee's offer as a follow-up, and holds the window open for it", async () => {
    const offer = "Bee only counted Eva itself. CarePulse and vmem keep separate user data, so say if you want those counted too.";
    const { say, commands, state } = await loadStore({ command: async (request) => result([request.command === "count Eva users" ? offer : "Done."]) });
    await say("Bee, count Eva users");
    await vi.advanceTimersByTimeAsync(90_000);
    expect(state().conversationOpen).toBe(true);
    await say("Yes, I do.");
    expect(commands.map((request) => request.command)).toEqual(["count Eva users", "Yes, I do."]);
    expect(state().session.lines).toEqual([]);
  });

  it("leaves a bare yes in the meeting when Bee neither asked nor offered", async () => {
    const { say, commands, state } = await loadStore();
    await say("Bee, open Teams");
    await say("Yes.");
    expect(commands).toHaveLength(1);
    expect(state().session.lines.map((line) => line.text)).toEqual(["Yes."]);
  });

  it("reopens on a clear desktop request just after thanks, and not once the reopen window has passed", async () => {
    const { say, commands, state } = await loadStore();
    await say("Bee, open Outlook");
    await say("Okay, thanks.");
    expect(state().conversationOpen).toBe(false);
    await say("I said open teams.");
    expect(commands.map((request) => request.command)).toEqual(["open Outlook", "I said open teams."]);
    await say("Thanks.");
    await vi.advanceTimersByTimeAsync(REOPEN_WINDOW_MS);
    await say("Open Slack.");
    expect(commands).toHaveLength(2);
    expect(state().session.lines.map((line) => line.text)).toEqual(["Open Slack."]);
  });

  it("never reopens on meeting talk after thanks, or after the meeting turned back to others", async () => {
    const first = await loadStore();
    await first.say("Bee, open Outlook");
    await first.say("Thanks.");
    await first.say("we should open the doc later");
    await first.say("open question about the budget");
    expect(first.commands).toHaveLength(1);

    vi.resetModules();
    const second = await loadStore();
    await second.say("Bee, open Outlook");
    await second.say("Thanks.");
    await second.caption("Can someone open the deck?");
    await second.say("Open the deck.");
    expect(second.commands).toHaveLength(1);
  });
});
