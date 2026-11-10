import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  recapRequestSchema,
  type CommandRequest,
  type MeetingSummaryRequest,
  type PipelineResult,
  type RecapRequest,
  type RecapResult,
  type SettingsView,
  type UserReturned,
} from "../../shared/ipc";
import type { SessionLine } from "../../core/session-lines";
import type { startMicSession } from "./speech";

// Phrase ids for lines the stubbed mic session hands over (core/speech.ts PhraseLine).
let phraseSeq = 0;
const nextPhrase = () => (phraseSeq += 1);

// "What did I miss?" in the store (core/recap.ts): the recap card when main says the user is back, when the mic goes on in a
// meeting that has started, and on "Bee, what did I miss?". Preload (window.bee), Clerk, the mic and speech-to-text are stubbed.
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

// Other people's lines arrive as live captions from the call window.
const said = (speaker: string, text: string) => ({ speaker, text });

async function loadStore(options: { recap?: RecapResult } = {}) {
  const commands: CommandRequest[] = [];
  const recaps: RecapRequest[] = [];
  let returned: (payload: UserReturned) => void = () => undefined;
  vi.stubGlobal("window", {
    bee: {
      getSettings: async () => SETTINGS,
      saveSettings: async () => SETTINGS,
      mcp: { list: async () => [] },
      checkForUpdate: async () => ({ currentVersion: "0.0.0", latestVersion: null, available: false, error: null }),
      setWindowSize: async () => undefined,
      onLunaActivity: () => () => undefined,
      onLunaPartial: () => () => undefined,
      cancelPipeline: async () => undefined,
      computer: { onUpdate: () => () => undefined },
      runPipeline: async () => result(["Offer 10% off."]),
      runCommand: async (request: CommandRequest) => {
        commands.push(request);
        return result(["Opened Teams"]);
      },
      conversationEnded: async () => undefined,
      recapSummary: async (request: RecapRequest) => {
        recaps.push(recapRequestSchema.parse(request));
        return options.recap ?? null;
      },
      writeMeetingSummary: async (_request: MeetingSummaryRequest) => ({ path: "/notes/meeting.md", usedLlm: true, error: null, followUp: ['Saved "Weekly sync": 1 action item', "- Sam: send the quote"] }),
      openMeetingSummary: async () => "",
      onUserReturned: (listener: typeof returned) => {
        returned = listener;
        return () => undefined;
      },
    },
  });
  const store = await import("./store");
  await vi.advanceTimersByTimeAsync(2100);
  const fromTeammates = async (...lines: Array<{ speaker: string; text: string }>) => {
    store.actions.captionLines(lines);
    await vi.advanceTimersByTimeAsync(2100);
  };
  /** Main says the user is back after leaving at `since`. */
  const back = async (since: number) => {
    returned({ since });
    await vi.advanceTimersByTimeAsync(0);
  };
  const say = async (text: string) => {
    const mic = micSessions.at(-1);
    if (!mic) throw new Error("no mic session");
    mic.onSpeechEnd?.();
    mic.onLine({ id: nextPhrase(), text, final: true });
    mic.onSettled?.("words");
    await vi.advanceTimersByTimeAsync(1000);
  };
  return { store, fromTeammates, back, say, commands, recaps, card: () => store.getBeeState().meetingCard };
}

describe("store: what did I miss", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T10:00:00Z"));
    vi.resetModules();
    micSessions.length = 0;
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows the recap once when the user is back, with the lines said while they were away", async () => {
    const { store, fromTeammates, back, card } = await loadStore();
    await fromTeammates(said("Priya", "Hello, starting now."));
    const left = Date.now();
    await vi.advanceTimersByTimeAsync(60_000);
    await fromTeammates(said("Priya", "Launch moves to the 4th."), said("Sam", "I'll update the pricing page."));
    void store.actions.dismissIsland();
    await vi.advanceTimersByTimeAsync(1000);
    await back(left);
    expect(card()?.label).toBe("Recap");
    expect(card()?.lines).toEqual(["While you were away", "Priya: Launch moves to the 4th.", "Sam: I'll update the pricing page."]);
    expect(store.responseOpen(store.getBeeState())).toBe(true);
    // The same away period again: no second card.
    void store.actions.dismissIsland();
    await vi.advanceTimersByTimeAsync(1000);
    await back(left);
    expect(card()).toBeNull();
  });

  it("shows nothing when the user is back and nothing happened", async () => {
    const { back, card } = await loadStore();
    const left = Date.now();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    await back(left);
    expect(card()).toBeNull();
  });

  it("sums up many missed lines with the AI, and lists Bee's own activity", async () => {
    const { store, fromTeammates, back, recaps, card } = await loadStore({ recap: ["Launch moved to the 4th", "Sam owns pricing"] });
    const left = Date.now();
    await vi.advanceTimersByTimeAsync(1000);
    await fromTeammates(said("Priya", "Launch moves to the 4th."), said("Sam", "I'll update the pricing page."), said("Priya", "Legal has signed off."));
    store.actions.backgroundUpdate({ id: "bg-1", title: "Draft release notes", status: "running", tool: null, result: null, startedAt: 0 });
    store.actions.backgroundUpdate({ id: "bg-1", title: "Draft release notes", status: "done", tool: null, result: result(["Drafted."]), startedAt: 0 });
    void store.actions.dismissIsland();
    await vi.advanceTimersByTimeAsync(1000);
    await back(left);
    await vi.waitFor(() => expect(card()?.lines).toEqual(["While you were away", "Launch moved to the 4th", "Sam owns pricing", "Background task done: Draft release notes"]));
    expect(recaps.map((request) => request.lines)).toEqual([["Priya: Launch moves to the 4th.", "Sam: I'll update the pricing page.", "Priya: Legal has signed off."]]);
  });

  it("falls back to a plain count and the last lines without the AI", async () => {
    const { store, fromTeammates, back, card } = await loadStore();
    const left = Date.now();
    await vi.advanceTimersByTimeAsync(1000);
    await fromTeammates(said("Priya", "Launch moves to the 4th."), said("Sam", "I'll update the pricing page."), said("Priya", "Legal has signed off."));
    void store.actions.dismissIsland();
    await vi.advanceTimersByTimeAsync(1000);
    await back(left);
    expect(card()?.lines).toEqual(["While you were away", "3 lines from Priya and Sam. Latest:", "Sam: I'll update the pricing page.", "Priya: Legal has signed off."]);
  });

  it("offers a saved meeting's follow-up on the recap", async () => {
    const { store, fromTeammates, back, card } = await loadStore();
    await fromTeammates(said("Priya", "Sam will send the quote."));
    const left = Date.now();
    await vi.advanceTimersByTimeAsync(1000);
    await store.actions.endMeeting({ auto: true });
    void store.actions.dismissIsland();
    await vi.advanceTimersByTimeAsync(1000);
    await back(left);
    expect(card()?.lines).toEqual(["While you were away", 'Saved "Weekly sync": 1 action item']);
    expect(card()?.buttons.map((button) => button.label)).toEqual(["Draft follow-up email", "Create tasks"]);
  });

  it("offers the recap once when the mic goes on in a meeting others started", async () => {
    const { store, fromTeammates, card } = await loadStore();
    await fromTeammates(said("Priya", "Let's start with the launch."), said("Sam", "Pricing is ready."));
    void store.actions.dismissIsland();
    await vi.advanceTimersByTimeAsync(1000);
    await store.actions.toggleMic();
    expect(card()?.lines).toEqual(["Before you joined", "Priya: Let's start with the launch.", "Sam: Pricing is ready."]);
    void store.actions.dismissIsland();
    await vi.advanceTimersByTimeAsync(1000);
    await store.actions.toggleMic();
    await store.actions.toggleMic();
    expect(card()).toBeNull();
  });

  it("answers \"Bee, what did I miss?\" with the recap, not an AI request", async () => {
    const { store, fromTeammates, say, commands, card } = await loadStore();
    await store.actions.toggleMic();
    await say("Bee, what did I miss?");
    expect(commands).toEqual([]);
    expect(card()?.lines).toEqual([`Nothing new since ${new Date(Date.now() - 30 * 60_000 - 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`]);
    void store.actions.dismissIsland();
    await vi.advanceTimersByTimeAsync(1000);
    await fromTeammates(said("Priya", "We picked the blue design."));
    await say("Bee, catch me up");
    expect(commands).toEqual([]);
    expect(card()?.lines).toEqual(["While you were away", "Priya: We picked the blue design."]);
    await say("Bee, open Teams");
    expect(commands.map((request) => request.command)).toEqual(["open Teams"]);
  });
});
