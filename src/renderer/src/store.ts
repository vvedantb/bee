import { getToken } from "@clerk/electron/react";
import { useSyncExternalStore } from "react";
import { mergeLines, pipelineText, summaryTranscript, type SessionLine } from "../../core/sync-lines";
import {
  SESSION_TRANSCRIPT_MAX,
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
import { openMic } from "./mic";
import { startMicSession } from "./speech";

export type Tab = "live" | "settings";

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

// App-wide state shared by the notch and the panel. Local form input stays in the DOM (uncontrolled forms).
export type BeeState = {
  settings: SettingsView | null;
  expanded: boolean;
  // True while the panel plays its exit animation, before the window shrinks.
  collapsing: boolean;
  tab: Tab;
  result: PipelineResult | null;
  session: MeetingSession;
  summary: SummaryState;
  busy: boolean;
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

const PIPELINE_WINDOW = 8;
// Matches the panel exit animation in styles.css.
const COLLAPSE_MS = 160;
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
  expanded: false,
  collapsing: false,
  tab: "live",
  result: null,
  session: EMPTY_SESSION,
  summary: { saving: false, result: null, error: null },
  busy: false,
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

export function useBee(): BeeState {
  return useSyncExternalStore(subscribe, () => state);
}

let latestRun = 0;
let sampleIndex = 0;
let localSeq = 0;
let stopMic: (() => void) | null = null;
let sentSize: WindowSize = "collapsed";
let ticking = false;

export function syncCard(current: BeeState): SyncCard {
  const teams = current.teams;
  if (!teams) return null;
  if (teams.prompt) return "prompt";
  if (teams.room && current.inviteOpen) return "invite";
  if (teams.merge) return "merge";
  return null;
}

/** Resize the window to fit: full panel, notch plus sync card, or notch only. */
async function applyWindowSize(): Promise<void> {
  const size: WindowSize = state.expanded && !state.collapsing ? "expanded" : syncCard(state) ? "prompt" : "collapsed";
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
  set({ session: { ...state.session, lines: mergeLines(state.session.lines, lines, SESSION_TRANSCRIPT_MAX) } });
}

/** Retrieve → Jev → Luna on the last 8 lines, teammates' lines labelled "Alice: …". */
async function runPipeline(): Promise<void> {
  const transcript = state.session.lines.slice(-PIPELINE_WINDOW).map(pipelineText);
  if (transcript.length === 0) return;
  const run = ++latestRun;
  set({ busy: true, error: null });
  try {
    const result = await window.bee.runPipeline({ transcript, sessionToken: await sessionToken() });
    if (run !== latestRun) return;
    set({ result, busy: false });
    addToSession(result);
  } catch (error) {
    if (run === latestRun) set({ busy: false, error: error instanceof Error ? error.message : "Pipeline failed" });
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

  async setExpanded(expanded: boolean): Promise<void> {
    if (expanded) {
      set({ collapsing: false, expanded: true });
      await applyWindowSize();
      return;
    }
    // Let the panel fade out before the window shrinks under it.
    set({ collapsing: true });
    await new Promise((resolve) => setTimeout(resolve, COLLAPSE_MS));
    if (!state.collapsing) return;
    set({ expanded: false, collapsing: false });
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
    set({ session: EMPTY_SESSION, summary: { saving: true, result: null, error: null } });
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
        // Same path as a typed line; latestRun drops results from superseded runs.
        onLine: (line) => void actions.simulateLine(line, "mic"),
        onError: (error) => setMic({ error }),
      });
      capture.start((frame) => setMic({ level: Math.min(1, mic.push(frame) * 4) }));
      stopMic = () => {
        capture.stop();
        // The phrase in progress is still transcribed.
        void mic.stop();
      };
      set({ mic: { on: true, level: 0, error: null } });
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
// Quiet check at start-up; the notch shows an update button only when one is available.
void actions.checkForUpdate();
setInterval(() => void teamsTick(), SYNC_TICK_MS);
