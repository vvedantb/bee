import { getToken } from "@clerk/electron/react";
import { useSyncExternalStore } from "react";
import { detectLinks, mergeChips, visibleChips, type LinkChip } from "../../core/link-suggest";
import { mergeLines, pipelineText, summaryTranscript, type SessionLine } from "../../core/sync-lines";
import {
  SESSION_TRANSCRIPT_MAX,
  type McpSave,
  type McpServerView,
  type McpSetEnabled,
  type McpTestResult,
  type MeetingSummaryResult,
  type PipelineResult,
  type SettingsUpdate,
  type SettingsView,
  type TeamsActionInput,
  type TeamsView,
  type TranscribeResult,
  type UpdateCheck,
  type WindowSize,
} from "../../shared/ipc";
import { ISLAND_IDLE_MS, islandPhase, islandShowsBody, shouldAutoCollapse } from "./island";
import { openMic, openSystemAudio } from "./mic";
import { startMicSession } from "./speech";

export type Tab = "live" | "connectors" | "settings";

// ready: the installer is downloaded. check: the last successful check, kept while downloading.
export type UpdateState = {
  status: "idle" | "checking" | "downloading" | "ready";
  check: UpdateCheck | null;
  error: string | null;
};

// Everything since the last saved summary: own and synced teammates' lines, merged by time. Never rendered.
export type MeetingSession = { lines: SessionLine[]; notesCited: string[]; tips: string[] };


// The card under the notch: the join/start popup, the optional invite step after starting, or a merge offer.
export type SyncCard = "prompt" | "invite" | "merge" | null;

// result: the last saved summary, kept so the Live tab can open it.
export type SummaryState = { saving: boolean; result: MeetingSummaryResult | null; error: string | null };

// Test connection, per server id. Cleared when the server is edited or removed.
export type McpTestState = { busy: boolean; result: McpTestResult | null };

// App-wide state shared by the notch and the panel. Local form input stays in the DOM (uncontrolled forms).
export type BeeState = {
  settings: SettingsView | null;
  // MCP servers (no secrets) and their last test.
  mcp: { servers: McpServerView[]; tests: Record<string, McpTestState>; error: string | null };
  expanded: boolean;
  // True while the panel plays its exit animation, before the window shrinks.
  collapsing: boolean;
  tab: Tab;
  result: PipelineResult | null;
  session: MeetingSession;
  summary: SummaryState;
  busy: boolean;
  // True from the end of a spoken phrase until its speech-to-text is done: the pill reads "Got it…". State only, never words.
  heard: boolean;
  // Tips streamed by the run in flight (finished lines). They show before the full result lands, which replaces them.
  partialTips: string[] | null;
  // The tool Luna last used in this run (a raw tool name; island.ts activityLabel turns it into text). Null otherwise.
  activity: string | null;
  // Island: the user closed the body for the result on screen. A new result clears it.
  dismissed: boolean;
  // True while the body plays its exit animation, before the window shrinks.
  islandClosing: boolean;
  // Link chips for the current turn (the latest line plus the tips that came back), and the ones the user closed.
  chips: LinkChip[];
  dismissedChipIds: string[];
  error: string | null;
  mic: { on: boolean; level: number; error: string | null };
  update: UpdateState;
  // Teams mode, from main (null until the first tick after sign-in).
  teams: TeamsView | null;
  teamsBusy: boolean;
  teamsError: string | null;
  // The invite step shows after starting a sync, until Done.
  inviteOpen: boolean;
};

/** True when the root carries data-motion="reduce" (App sets it from the Animations setting). */
export function motionReduced(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.motion === "reduce";
}

const PIPELINE_WINDOW = 8;
// Matches the panel exit animation in styles.css.
const COLLAPSE_MS = 160;
// Matches the island exit animation in styles.css.
const ISLAND_CLOSE_MS = 200;
// With motion reduced, CSS animations last 1ms, so exits do not wait for them.
const REDUCED_EXIT_MS = 1;
const MIC_OFF = { on: false, level: 0 };
const EMPTY_SESSION: MeetingSession = { lines: [], notesCited: [], tips: [] };
const SESSION_LIST_MAX = 100;
const SYNC_TICK_MS = 2000;

export const SAMPLE_LINES = [
  "Let's pick up the Acme renewal. They are asking for a bigger discount.",
  "Could we go to twenty percent off if they sign this week?",
  "Also, when does SSO ship for enterprise customers?",
  "Separately, what salary band are we offering the backend candidate?",
];

let state: BeeState = {
  settings: null,
  mcp: { servers: [], tests: {}, error: null },
  expanded: false,
  collapsing: false,
  tab: "live",
  result: null,
  session: EMPTY_SESSION,
  summary: { saving: false, result: null, error: null },
  busy: false,
  heard: false,
  partialTips: null,
  activity: null,
  dismissed: false,
  islandClosing: false,
  chips: [],
  dismissedChipIds: [],
  error: null,
  mic: { ...MIC_OFF, error: null },
  update: { status: "idle", check: null, error: null },
  teams: null,
  teamsBusy: false,
  teamsError: null,
  inviteOpen: false,
};
const listeners = new Set<() => void>();

function set(patch: Partial<BeeState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The current state outside React (tests, event handlers). */
export function getBeeState(): BeeState {
  return state;
}

export function useBee(): BeeState {
  return useSyncExternalStore(subscribe, () => state);
}

let latestRun = 0;
// Phrases heard whose speech-to-text is still running.
let heardPending = 0;
let sampleIndex = 0;
let localSeq = 0;
let turnSeq = 0;
let turnText = "";
let stopMic: (() => void) | null = null;
let sentSize: WindowSize = "collapsed";
let ticking = false;
let islandHovered = false;
let islandActivityAt = 0;
let islandTimer: ReturnType<typeof setTimeout> | undefined;
const EMPTY_RESULT = { tips: [], sources: [], guideError: null };

/**
 * What the island and panel show: the last result, with the streamed tips over it while a run is in flight.
 * Old tips stay visible while busy. An old error and note do not, and streamed tips drop the old sources.
 */
export function displayResult(current: Pick<BeeState, "result" | "partialTips" | "busy">): PipelineResult | null {
  const { result, partialTips, busy } = current;
  if (partialTips) {
    return { ...(result ?? { notes: [], rankSource: "fallback", rankError: null, timingsMs: ZERO_TIMINGS }), tips: partialTips, sources: [], guideError: null, guideNote: null };
  }
  return result && busy ? { ...result, guideError: null, guideNote: null } : result;
}

const ZERO_TIMINGS = { retrieve: 0, rank: 0, guide: 0, mcp: 0, lunaFirstToken: null, lunaTotal: 0 };

/** Restart the inactivity clock. The body closes ISLAND_IDLE_MS after the last result or pointer leave. */
function touchIsland(): void {
  islandActivityAt = Date.now();
  clearTimeout(islandTimer);
  if (!islandOpen(state) || islandHovered) return;
  islandTimer = setTimeout(autoCollapseIsland, ISLAND_IDLE_MS);
}

function autoCollapseIsland(): void {
  // Chips can hold the body open while Luna thinks; the pill's phase then stays "thinking" and nothing collapses.
  const phase = state.busy ? "thinking" : islandOpen(state) ? "expanded" : "idle";
  if (shouldAutoCollapse({ phase, hovered: islandHovered, lastActivityAt: islandActivityAt, now: Date.now() })) void closeIsland();
}

async function closeIsland(): Promise<void> {
  if (!islandOpen(state) || state.islandClosing) return;
  set({ islandClosing: true });
  await new Promise((resolve) => setTimeout(resolve, motionReduced() ? REDUCED_EXIT_MS : ISLAND_CLOSE_MS));
  if (!state.islandClosing) return;
  set({ dismissed: true, islandClosing: false });
  await applyWindowSize();
}

export function syncCard(current: BeeState): SyncCard {
  const teams = current.teams;
  if (!teams) return null;
  if (teams.prompt) return "prompt";
  if (teams.room && current.inviteOpen) return "invite";
  if (teams.merge) return "merge";
  return null;
}

/** The island body (tips, sources and link chips under the pill) is open: something to show, and no panel or sync card in the way. */
export function islandOpen(current: BeeState): boolean {
  if (current.expanded || syncCard(current)) return false;
  return islandShowsBody(islandArgs(current));
}

/** What island.ts needs from the state: the result (or an empty one), the chips still shown, and the flags. */
export function islandArgs(current: BeeState) {
  return {
    ...(displayResult(current) ?? EMPTY_RESULT),
    chipCount: visibleChips(current.chips, current.dismissedChipIds).length,
    dismissed: current.dismissed,
    busy: current.busy,
  };
}

/** Resize the window to fit: full panel, notch plus sync card, notch plus island body, or notch only. */
async function applyWindowSize(): Promise<void> {
  const size: WindowSize =
    state.expanded && !state.collapsing ? "expanded" : syncCard(state) ? "prompt" : islandOpen(state) ? "response" : "collapsed";
  if (size === sentSize) return;
  sentSize = size;
  await window.bee.setWindowSize(size);
}

function setTeams(teams: TeamsView): void {
  set({ teams, inviteOpen: state.inviteOpen && teams.room !== null });
  void applyWindowSize();
}

function selfName(): string {
  return state.teams?.me?.displayName ?? "You";
}

function addLines(lines: SessionLine[]): void {
  const before = state.session.lines;
  const merged = mergeLines(before, lines, SESSION_TRANSCRIPT_MAX);
  set({ session: { ...state.session, lines: merged } });
  // Lines already seen start no turn. New ones reset chips and dismissals, then fill from what was just said.
  if (merged !== before) startTurn(lines);
}

/**
 * Asks main to personalise chips (exact page from history, or drop one). Chips stay as they are on any failure or when the turn
 * has moved on. Chips not sent (added since) are kept. Main sends text to vmem and Jev only with the setting on.
 */
async function enrichChips(sent: LinkChip[], text: string, seq: number): Promise<void> {
  if (sent.length === 0 || !state.settings?.personalisedLinks) return;
  try {
    const reply = await window.bee.enrichLinks({ turn: text.slice(0, 4000), chips: sent });
    if (seq !== turnSeq) return;
    const sentIds = new Set(sent.map((chip) => chip.id));
    const byId = new Map(reply.chips.map((chip) => [chip.id, chip]));
    set({ chips: state.chips.flatMap((chip) => (sentIds.has(chip.id) ? (byId.has(chip.id) ? [byId.get(chip.id) as LinkChip] : []) : [chip])) });
    void applyWindowSize();
  } catch {
    // Plain chips stay.
  }
}

/** A new spoken or simulated line. Chips from its links open the island body even before Luna answers. */
function startTurn(lines: SessionLine[]): void {
  const chips = mergeChips([], lines.flatMap((line) => detectLinks(line.text)));
  const seq = ++turnSeq;
  turnText = lines.map((line) => line.text).join("\n");
  void enrichChips(chips, turnText, seq);
  set(chips.length > 0 ? { chips, dismissedChipIds: [], dismissed: false, islandClosing: false } : { chips, dismissedChipIds: [] });
  if (chips.length > 0) {
    touchIsland();
    void applyWindowSize();
  }
}

/** Retrieve → Jev → Luna on the last 8 lines, teammates' lines labelled "Alice: …". */
async function runPipeline(): Promise<void> {
  const transcript = state.session.lines.slice(-PIPELINE_WINDOW).map(pipelineText);
  if (transcript.length === 0) return;
  const previous = latestRun;
  const run = ++latestRun;
  // A newer line supersedes the run in flight: stop its Jev and Luna in main. Fire and forget.
  if (previous > 0) void window.bee.cancelPipeline({ runId: previous }).catch(() => undefined);
  set({ busy: true, heard: false, activity: null, error: null });
  void applyWindowSize();
  // Tool events carry no run id; the latest run owns them, and finishing clears the label.
  const stopActivity = window.bee.onLunaActivity((tool) => {
    if (run === latestRun) set({ activity: tool });
  });
  // Streamed tips show at once, over the previous ones, without waiting for the whole run.
  const stopPartial = window.bee.onLunaPartial(({ runId, tips }) => {
    if (run !== latestRun || (runId !== undefined && runId !== run)) return;
    set({ partialTips: tips, dismissed: false, islandClosing: false });
    touchIsland();
    void applyWindowSize();
  });
  try {
    const result = await window.bee.runPipeline({ transcript, runId: run, sessionToken: await sessionToken() });
    if (run !== latestRun) return;
    // The tips' links join this turn's chips (deduped, capped).
    const chips = mergeChips(state.chips, result.tips.flatMap((tip) => detectLinks(tip)));
    const added = chips.filter((chip) => !state.chips.some((known) => known.id === chip.id));
    void enrichChips(added, [turnText, ...result.tips].join("\n"), turnSeq);
    set({
      result,
      partialTips: null,
      chips,
      busy: false,
      activity: null,
      dismissed: false,
      islandClosing: false,
    });
    addToSession(result);
    touchIsland();
  } catch (error) {
    if (run === latestRun) set({ busy: false, partialTips: null, activity: null, error: error instanceof Error ? error.message : "Pipeline failed" });
  } finally {
    stopActivity();
    stopPartial();
    void applyWindowSize();
  }
}

/** Shares one mic phrase with the sync. Main applies the share gate; failures leave Bee working solo. */
async function shareLine(line: SessionLine): Promise<void> {
  try {
    await window.bee.teams.publish({ text: line.text, clientTs: line.clientTs, source: "mic", sessionToken: await sessionToken() });
  } catch {
    // The next tick reports relay trouble.
  }
}

/** Detection, presence and teammates' phrases, every 2 s while signed in. */
async function teamsTick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const token = await getToken().catch(() => null);
    if (!token) return;
    const { view, lines } = await window.bee.teams.tick(token);
    setTeams(view);
    if (lines.length > 0) {
      addLines(lines);
      void runPipeline();
    }
  } catch {
    // Main or the relay failed this tick; the next one tries again.
  } finally {
    ticking = false;
  }
}

async function sessionToken(): Promise<string> {
  const token = await getToken();
  if (!token) throw new Error("Sign in to Bee to get guidance.");
  return token;
}

async function transcribePhrase(audio: Uint8Array<ArrayBuffer>): Promise<TranscribeResult> {
  return window.bee.transcribe({ audio, sessionToken: await sessionToken() });
}

function setUpdate(patch: Partial<UpdateState>): void {
  set({ update: { ...state.update, ...patch } });
}

function setSummary(patch: Partial<SummaryState>): void {
  set({ summary: { ...state.summary, ...patch } });
}

// Adds new items to the end, skipping ones already present, and keeps the newest max.
function mergeUnique(list: string[], items: string[], max: number): string[] {
  return [...list, ...items.filter((item, index) => !list.includes(item) && items.indexOf(item) === index)].slice(-max);
}

/** Record the notes cited and the tips from a shown result. */
function addToSession(result: PipelineResult): void {
  const cited = result.notes.filter((note) => note.cite !== null).map((note) => note.title);
  const session = state.session;
  set({
    session: {
      ...session,
      notesCited: mergeUnique(session.notesCited, cited, SESSION_LIST_MAX),
      tips: mergeUnique(session.tips, result.tips, SESSION_LIST_MAX),
    },
  });
}

function setMic(patch: Partial<BeeState["mic"]>): void {
  set({ mic: { ...state.mic, ...patch } });
}

function setMcpTest(id: string, test: McpTestState): void {
  set({ mcp: { ...state.mcp, tests: { ...state.mcp.tests, [id]: test } } });
}

// Runs an MCP change in main and stores the new list, or the error.
async function mcpChange(change: () => Promise<McpServerView[]>, staleTestId?: string): Promise<boolean> {
  try {
    const servers = await change();
    const tests = { ...state.mcp.tests };
    if (staleTestId) delete tests[staleTestId];
    set({ mcp: { servers, tests, error: null } });
    // The personalised-links default follows the vmem connector, so the settings view changes with it.
    void actions.refreshSettings().catch(() => undefined);
    return true;
  } catch (error) {
    // Electron prefixes a handler's error with "Error invoking remote method …".
    const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, "") : "";
    set({ mcp: { ...state.mcp, error: message || "Could not save the server" } });
    return false;
  }
}

export const actions = {
  async refreshSettings(): Promise<void> {
    set({ settings: await window.bee.getSettings() });
  },

  /** Resolves true when saved. */
  async saveSettings(update: SettingsUpdate): Promise<boolean> {
    try {
      set({ settings: await window.bee.saveSettings(update), error: null });
      return true;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : "Could not save settings" });
      return false;
    }
  },

  async refreshMcp(): Promise<void> {
    try {
      set({ mcp: { ...state.mcp, servers: await window.bee.mcp.list() } });
    } catch {
      // Settings still work without the MCP list.
    }
  },

  /** Resolves true when saved. The server's old test result is dropped. */
  async saveMcpServer(server: McpSave): Promise<boolean> {
    return mcpChange(() => window.bee.mcp.save(server), server.id);
  },

  async removeMcpServer(id: string): Promise<void> {
    await mcpChange(() => window.bee.mcp.remove(id), id);
  },

  async setMcpEnabled(update: McpSetEnabled): Promise<void> {
    await mcpChange(() => window.bee.mcp.setEnabled(update));
  },

  /** Signs in to an MCP server in the system browser, saving it first when it is new. The row shows Disconnect once tokens are stored. */
  async connectMcpServer(save: McpSave, existingId?: string): Promise<void> {
    await mcpChange(async () => {
      let id = existingId;
      if (!id) {
        const servers = await window.bee.mcp.save(save);
        // Keep the new row on screen if the sign-in fails.
        set({ mcp: { ...state.mcp, servers } });
        id = servers.find((server) => server.name === save.name)?.id;
      }
      if (!id) throw new Error("Could not save the server");
      return window.bee.mcp.authorize(id);
    }, existingId);
  },

  async testMcpServer(id: string): Promise<void> {
    setMcpTest(id, { busy: true, result: null });
    try {
      const result = await window.bee.mcp.test(id);
      setMcpTest(id, { busy: false, result });
      await actions.refreshMcp();
    } catch (error) {
      setMcpTest(id, { busy: false, result: { ok: false, error: error instanceof Error ? error.message : "Test failed" } });
    }
  },

  /** Close the island body without closing the window. */
  dismissIsland(): Promise<void> {
    return closeIsland();
  },

  /** Hide one chip for this turn. The island closes when nothing else is left to show. */
  dismissChip(id: string): void {
    if (state.dismissedChipIds.includes(id)) return;
    set({ dismissedChipIds: [...state.dismissedChipIds, id] });
    touchIsland();
    void applyWindowSize();
  },

  /** Open a chip's link in the default browser. Only called from a click; main validates the URL. */
  async openLink(url: string): Promise<void> {
    try {
      await window.bee.openExternalUrl(url);
    } catch {
      // The chip stays; the user can click again.
    }
  },

  /** The pointer on the island holds the body open; leaving restarts the clock. */
  setIslandHover(hovered: boolean): void {
    islandHovered = hovered;
    touchIsland();
  },

  async setExpanded(expanded: boolean): Promise<void> {
    if (expanded) {
      clearTimeout(islandTimer);
      set({ collapsing: false, expanded: true });
      await applyWindowSize();
      return;
    }
    // Let the panel fade out before the window shrinks under it.
    set({ collapsing: true });
    await new Promise((resolve) => setTimeout(resolve, motionReduced() ? REDUCED_EXIT_MS : COLLAPSE_MS));
    if (!state.collapsing) return;
    set({ expanded: false, collapsing: false });
    touchIsland();
    await applyWindowSize();
  },

  setTab(tab: Tab): void {
    set({ tab });
  },

  async openSettings(): Promise<void> {
    set({ tab: "settings" });
    if (!state.expanded) await actions.setExpanded(true);
  },

  nextSampleLine(): string {
    const line = SAMPLE_LINES[sampleIndex % SAMPLE_LINES.length] ?? "";
    sampleIndex += 1;
    return line;
  },

  /**
   * Add a meeting line (typed, or a phrase from Grok STT) and run retrieve → Jev → Luna. Mic phrases are also
   * shared with the Teams sync, if one is on and sharing is not paused.
   */
  async simulateLine(line: string, source: "typed" | "mic" = "typed"): Promise<void> {
    const text = line.trim();
    if (!text) return;
    localSeq += 1;
    const own: SessionLine = {
      id: `local-${localSeq}`,
      own: true,
      speakerId: state.teams?.me?.userId ?? "local",
      speakerName: selfName(),
      text,
      clientTs: Date.now(),
      serverTs: null,
    };
    addLines([own]);
    if (source === "mic" && state.teams?.room) void shareLine(own);
    await runPipeline();
  },

  /**
   * Stop the mic and write the session's summary to the notes folder. The session starts empty for the next
   * meeting straight away; on failure it is put back, ahead of any lines that arrived meanwhile.
   */
  async endMeeting(): Promise<void> {
    const ended = state.session;
    if (ended.lines.length === 0 || state.summary.saving) return;
    if (stopMic) actions.stopMic(null);
    set({ session: EMPTY_SESSION, chips: [], dismissedChipIds: [], summary: { saving: true, result: null, error: null } });
    try {
      const result = await window.bee.writeMeetingSummary({
        transcript: summaryTranscript(ended.lines, selfName()),
        notesCited: ended.notesCited,
        tips: ended.tips,
        sessionToken: await sessionToken(),
      });
      setSummary({ saving: false, result });
    } catch (error) {
      const now = state.session;
      set({
        session: {
          lines: mergeLines(ended.lines, now.lines, SESSION_TRANSCRIPT_MAX),
          notesCited: mergeUnique(ended.notesCited, now.notesCited, SESSION_LIST_MAX),
          tips: mergeUnique(ended.tips, now.tips, SESSION_LIST_MAX),
        },
      });
      setSummary({ saving: false, error: error instanceof Error ? error.message : "Could not save the summary" });
    }
  },

  async openSummary(): Promise<void> {
    const path = state.summary.result?.path;
    if (!path) return;
    try {
      setSummary({ error: (await window.bee.openMeetingSummary(path)) || null });
    } catch (error) {
      setSummary({ error: error instanceof Error ? error.message : "Could not open the summary" });
    }
  },

  /** Mic on: each spoken phrase goes to Grok STT in main, then into simulateLine. The words are not shown. */
  async toggleMic(): Promise<void> {
    if (stopMic) {
      actions.stopMic(null);
      return;
    }
    try {
      const capture = await openMic();
      const mic = startMicSession({
        sampleRate: capture.sampleRate,
        transcribe: transcribePhrase,
        // The phrase is over: show "Got it…" now, before speech-to-text. A cough never gets here.
        onSpeechEnd: () => {
          heardPending += 1;
          set({ heard: true });
        },
        // Same path as a typed line; latestRun drops results from superseded runs.
        onLine: (line) => void actions.simulateLine(line, "mic"),
        onError: (error) => setMic({ error }),
        // After onLine, so busy is already set when the ack ends and the pill never falls back to "Listening…".
        onSettled: () => {
          heardPending = Math.max(0, heardPending - 1);
          if (heardPending === 0 && state.heard) set({ heard: false });
        },
      });
      capture.start((frame) => setMic({ level: Math.min(1, mic.push(frame) * 4) }));
      let micOn = true;
      stopMic = () => {
        micOn = false;
        capture.stop();
        // The phrase in progress is still transcribed.
        void mic.stop();
      };
      set({ mic: { on: true, level: 0, error: null } });
      // Best effort and off the critical path: the Screen Recording prompt never blocks the mic.
      void openSystemAudio().then((extra) => {
        if (!extra) return;
        if (micOn) capture.attachExtra(extra);
        else for (const track of extra.getTracks()) track.stop();
      });
    } catch (error) {
      setMic({ ...MIC_OFF, error: `Microphone unavailable: ${error instanceof Error ? error.message : String(error)}` });
    }
  },

  stopMic(error: string | null): void {
    const stop = stopMic;
    stopMic = null;
    stop?.();
    set({ mic: { ...MIC_OFF, error } });
  },

  async checkForUpdate(): Promise<void> {
    setUpdate({ status: "checking", error: null });
    const check = await window.bee.checkForUpdate();
    if (check.error) setUpdate({ status: "idle", error: check.error });
    else setUpdate({ status: "idle", check, error: null });
  },

  async downloadUpdate(): Promise<void> {
    setUpdate({ status: "downloading", error: null });
    const { error } = await window.bee.downloadUpdate();
    setUpdate({ status: error ? "idle" : "ready", error });
  },

  async installUpdate(): Promise<void> {
    const { error } = await window.bee.installUpdate();
    setUpdate({ error });
  },

  /** Teams mode: team, popup and sync actions. Resolves true on success; errors show in the UI. */
  async teams(action: TeamsActionInput): Promise<boolean> {
    set({ teamsBusy: true, teamsError: null });
    try {
      const result = await window.bee.teams.act({ ...action, sessionToken: await sessionToken() });
      set({ teamsBusy: false, teamsError: result.error, inviteOpen: action.type === "startSync" ? !result.error : state.inviteOpen });
      setTeams(result.view);
      return result.error === null;
    } catch (error) {
      set({ teamsBusy: false, teamsError: error instanceof Error ? error.message : "Teams action failed" });
      return false;
    }
  },

  /** Show or hide the invite step (the roster of teammates in a meeting). */
  setInviteOpen(inviteOpen: boolean): void {
    set({ inviteOpen });
    void applyWindowSize();
  },
};

void actions.refreshSettings();
void actions.refreshMcp();
// Quiet check at start-up; the notch shows an update button only when one is available.
void actions.checkForUpdate();
setInterval(() => void teamsTick(), SYNC_TICK_MS);
