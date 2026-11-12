import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commandRequestSchema,
  pipelineRequestSchema,
  teamsAudioLinesSchema,
  type CommandRequest,
  type MeetingSummaryRequest,
  type PipelineRequest,
  type PipelineResult,
  type SettingsView,
} from "../../shared/ipc";
import type { PhraseLine, startMicSession } from "./speech";

// Early phrase results in the store (core/speech.ts EARLY_END_MS): an early line shows at once, pending, and the phrase's final
// line revises it (reviseLine). Requests to Bee wait for the final; the echo guard runs on both; the summary waits for finals.
// Preload (window.bee), Clerk, the mic and speech-to-text are stubbed: the test hands over phrase lines as the session would.
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

let phraseSeq = 0;

async function loadStore() {
  const pipeline: PipelineRequest[] = [];
  const commands: CommandRequest[] = [];
  const summaries: MeetingSummaryRequest[] = [];
  vi.stubGlobal("window", {
    bee: {
      getSettings: async () => SETTINGS,
      mcp: { list: async () => [] },
      checkForUpdate: async () => ({ currentVersion: "0.0.0", latestVersion: null, available: false, error: null }),
      setWindowSize: async () => undefined,
      onLunaActivity: () => () => undefined,
      onLunaPartial: () => () => undefined,
      cancelPipeline: async () => undefined,
      runPipeline: async (request: PipelineRequest) => {
        pipeline.push(pipelineRequestSchema.parse(request));
        return result([`Tip ${pipeline.length}`]);
      },
      runCommand: async (request: CommandRequest) => {
        commands.push(commandRequestSchema.parse(request));
        return result(["Opened Teams"]);
      },
      conversationEnded: async () => undefined,
      computer: { onUpdate: () => () => undefined },
      writeMeetingSummary: async (request: MeetingSummaryRequest) => {
        summaries.push(request);
        return { path: "/notes/meeting.md", usedLlm: true, error: null, followUp: [] };
      },
    },
  });
  const store = await import("./store");
  await vi.advanceTimersByTimeAsync(2100);
  await store.actions.toggleMic();
  const mic = micSessions.at(-1);
  if (!mic) throw new Error("no mic session");
  /** One mic phrase: its early line (final false), then later its final. Returns the final, to send when the test wants. */
  const early = async (text: string) => {
    phraseSeq += 1;
    const id = phraseSeq;
    mic.onSpeechEnd?.();
    mic.onLine({ id, text, final: false });
    await vi.advanceTimersByTimeAsync(0);
    return async (final: string) => {
      mic.onLine({ id, text: final, final: true });
      mic.onSettled?.("words");
      await vi.advanceTimersByTimeAsync(1000);
    };
  };
  const say = async (text: string) => (await early(text))(text);
  /** Call audio from main, through the IPC schema: lines are phrases, a final one revises the early one with its id. */
  const heard = async (lines: PhraseLine[]) => {
    store.actions.teamsAudioLines(teamsAudioLinesSchema.parse({ id: 1, lines }).lines);
    await vi.advanceTimersByTimeAsync(1000);
  };
  const said = () => store.getBeeState().session.lines.map((line) => `${line.own ? "" : `${line.speakerName}: `}${line.text}${line.pending ? " …" : ""}`);
  return { store, early, say, heard, said, pipeline, commands, summaries };
}

describe("store: early phrase results", () => {
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

  it("shows an early line at once, pending, and a final with the same content words updates it with no second run", async () => {
    const t = await loadStore();
    const final = await t.early("Can we ship on Friday");
    expect(t.said()).toEqual(["Can we ship on Friday …"]);
    expect(t.pipeline).toHaveLength(1);
    await final("Can we ship on Friday?");
    expect(t.said()).toEqual(["Can we ship on Friday?"]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.pipeline).toHaveLength(1);
  });

  it("a final with changed content steers the answer on screen, never a new turn", async () => {
    const t = await loadStore();
    const final = await t.early("Can we ship on Friday");
    await vi.advanceTimersByTimeAsync(100);
    expect(t.store.getBeeState().result?.tips).toEqual(["Tip 1"]);
    await final("Can we ship on Friday or Monday?");
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.pipeline).toHaveLength(2);
    // Steering: the answer stays and goes to Luna as the keep list; the run reads the revised line.
    expect(t.pipeline[1]?.shown).toEqual(["Tip 1"]);
    expect(t.pipeline[1]?.transcript).toEqual(["Can we ship on Friday or Monday?"]);
    expect(t.said()).toEqual(["Can we ship on Friday or Monday?"]);
  });

  it("holds an early wake phrase: nothing is added until the final, which is one request", async () => {
    const t = await loadStore();
    const final = await t.early("Bee, open");
    expect(t.said()).toEqual([]);
    expect(t.commands).toEqual([]);
    await final("Bee, open Teams");
    expect(t.commands.map((command) => command.command)).toEqual(["open Teams"]);
    expect(t.said()).toEqual([]);
    expect(t.pipeline).toEqual([]);
  });

  it("an early line that only becomes a request in its final goes, and the final is the request", async () => {
    const t = await loadStore();
    const final = await t.early("Hey");
    expect(t.said()).toEqual(["Hey …"]);
    await final("Hey Bee, open Teams");
    expect(t.commands.map((command) => command.command)).toEqual(["open Teams"]);
    expect(t.said()).toEqual([]);
  });

  it("holds an early line while the wake word is armed, and while the conversation window is open", async () => {
    const t = await loadStore();
    await t.say("Bee.");
    const armed = await t.early("open Teams");
    expect(t.said()).toEqual([]);
    await armed("open Teams please");
    expect(t.commands.map((command) => command.command)).toEqual(["open Teams please"]);
    // The reply opened the conversation window: an early line that may be a follow-up waits for its final.
    await vi.advanceTimersByTimeAsync(100);
    expect(t.store.getBeeState().conversationOpen).toBe(true);
    const followUp = await t.early("the team one");
    expect(t.said()).toEqual([]);
    expect(t.commands).toHaveLength(1);
    await followUp("the team one, not the chat");
    expect(t.commands.length + t.said().length).toBe(2);
  });

  it("echo guard: an early mic line that repeats call audio is dropped, and its final never comes back", async () => {
    const t = await loadStore();
    await t.heard([{ id: 1, text: "Bee, what is our refund policy?", final: true }]);
    const runs = t.pipeline.length;
    const final = await t.early("Bee what is our refund policy");
    await final("Bee, what is our refund policy");
    expect(t.said()).toEqual(["Meeting: Bee, what is our refund policy?"]);
    expect(t.commands).toEqual([]);
    expect(t.pipeline).toHaveLength(runs);
  });

  it("echo guard: call audio replacing a pending mic line leaves nothing for the mic's final to revise", async () => {
    const t = await loadStore();
    const final = await t.early("can you send the contract today");
    await t.heard([{ id: 2, text: "Can you send the contract today?", final: true }]);
    expect(t.said()).toEqual(["Meeting: Can you send the contract today?"]);
    const runs = t.pipeline.length;
    await final("can you send the contract today please");
    expect(t.said()).toEqual(["Meeting: Can you send the contract today?"]);
    expect(t.pipeline).toHaveLength(runs);
  });

  it("call audio: an early line shows pending and its final revises the same line", async () => {
    const t = await loadStore();
    await t.heard([{ id: 3, text: "When does SSO", final: false }]);
    expect(t.said()).toEqual(["Meeting: When does SSO …"]);
    await t.heard([{ id: 3, text: "When does SSO ship for enterprise?", final: true }]);
    expect(t.said()).toEqual(["Meeting: When does SSO ship for enterprise?"]);
    expect(t.pipeline.at(-1)?.transcript).toEqual(["Meeting: When does SSO ship for enterprise?"]);
  });

  it("the summary waits for a pending final, and uses the early text when none comes in time", async () => {
    const t = await loadStore();
    const final = await t.early("We agreed to ship Friday");
    const ended = t.store.actions.endMeeting();
    await vi.advanceTimersByTimeAsync(500);
    expect(t.summaries).toEqual([]);
    await final("We agreed to ship on Friday");
    await ended;
    expect(t.summaries.map((summary) => summary.transcript)).toEqual([["We agreed to ship on Friday"]]);

    await t.early("Then we review the pricing");
    const late = t.store.actions.endMeeting();
    await vi.advanceTimersByTimeAsync(3000);
    await late;
    expect(t.summaries.at(-1)?.transcript).toEqual(["Then we review the pricing"]);
  });
});
