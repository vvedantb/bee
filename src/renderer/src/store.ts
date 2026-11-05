import { getToken } from "@clerk/electron/react";
import { useSyncExternalStore } from "react";
import { echoesOwnLine } from "../../core/agent-desktop-meeting";
import { debugLog, errorData } from "../../core/debug-log";
import { detectLinks, mergeChips, sourceChips, visibleChips, type LinkChip } from "../../core/link-suggest";
import { MAX_STEERING_TIPS, isFiller, isNewTurn, isQuestion, mergeTips, recentRestarts, runDelayMs, tipCap, tipKey, waitsForRun } from "../../core/steering";
import { mergeLines, pipelineText, summaryTranscript, type SessionLine } from "../../core/sync-lines";
import { TEAMS_AUDIO_SPEAKER, TEAMS_AUDIO_SPEAKER_ID, teamsAudioEcho, teamsAudioPlan, teamsAudioReplaced, type TeamsAudioPlan } from "../../core/teams-audio";
import { HISTORY_IDLE_MS, addExchange, commandFallbackReply, liveHistory, type BeeExchange } from "../../core/bee-history";
import { CONVERSATION_QUESTION_MS, CONVERSATION_WINDOW_MS, OTHERS_QUIET_MS, WAKE_FOLLOW_MS, isConfirmWords, isForBee, routeLine } from "../../core/wake-word";
import type { TeamsAudioFailure } from "../../core/teams-audio-protocol";
import {
  COMMAND_MAX_CHARS,
  SESSION_TRANSCRIPT_MAX,
  clampTip,
  type ComputerAccessView,
  type ComputerUpdate,
  type McpSave,
  type McpServerView,
  type McpSetEnabled,
  type McpTestResult,
  type MeetingContextView,
  type MeetingWindowCaptions,
  type MeetingSummaryResult,
  type PipelineResult,
  type SettingsUpdate,
  type SettingsView,
  type TeamsActionInput,
  type TeamsAudioStatus,
  type TeamsView,
  type TranscribeResult,
  type UpdateCheck,
  type WindowSize,
} from "../../shared/ipc";
import { HINT_SHOW_MS, createHintDetector, type Hint, type HintId } from "./hints";
import { islandOpenMs, islandShowsBody, shouldAutoCollapse, shouldShowResponse } from "./island";
import { LOGO_DONE_MS } from "./logo";
import { openMic } from "./mic";
import { motionReduced } from "./motion";
import { framePeak, startMicSession, type PhraseOutcome } from "./speech";
import { openTeamsAudio } from "./teams-audio";
import { downloadUpdate, installUpdate, updateNow } from "./update";

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

// The "Last time with these people…" card at meeting start: shown once per detected meeting (id), until the island closes.
export type MeetingCard = { id: number; lines: string[] };

// Computer use in progress for a direct request ("Bee, send Sam a message in Discord"): the step as one short line for the
// pill, and a Confirm prompt while one waits for the user's tap. Only the island's buttons answer it.
export type ComputerConfirm = Extract<ComputerUpdate, { type: "confirm" }>;
export type ComputerView = { runId: number; step: string; confirm: ComputerConfirm | null };

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
  // Live steering: a newer line came while tips were on screen. keptTips are those tips (complete lines), sent to Luna as the keep
  // list and shown dimmed; revising turns the pill to "Updating…". Both clear when the run settles. State only, never words beyond the tips.
  keptTips: string[];
  revising: boolean;
  // The publisher behind each of this turn's tips ("TfL"), by tipKey, from streamed and final results. Kept tips keep theirs while
  // a run revises them; a new turn clears it.
  tipSources: Record<string, string>;
  // The current turn asks a direct question (steering.ts isQuestion): while busy, the pill says the AI is answering.
  question: boolean;
  // Raw names of the run's tool calls in flight, one entry per call (notch.ts workingLabel). Empty when no run is busy.
  tools: string[];
  // True for LOGO_DONE_MS after a run settles with tips, so the logo plays its done loop once.
  done: boolean;
  // Island: the user closed the body for the result on screen. A new result clears it.
  dismissed: boolean;
  // True while the body plays its exit animation, before the window shrinks.
  islandClosing: boolean;
  // The user clicked the one-line answer in the pill to read it in full in the island. It never closes on its own: only the
  // dismiss button, a click outside the island, the panel or a new turn close it.
  fullText: boolean;
  // Link chips for the current turn (the latest line plus the tips that came back), and the ones the user closed.
  chips: LinkChip[];
  dismissedChipIds: string[];
  // The meeting main detected (window titles, Outlook calendar), and its card. Names only; the brief for Luna stays in main.
  meeting: MeetingContextView | null;
  meetingCard: MeetingCard | null;
  error: string | null;
  mic: { on: boolean; level: number; error: string | null };
  // A mic hint (hints.ts: no input, quiet, too loud, noisy) in the island body. Calm guidance, never mic.error. hintClosing: it
  // plays its exit before it goes.
  hint: { id: HintId; text: string } | null;
  hintClosing: boolean;
  update: UpdateState;
  // Teams mode, from main (null until the first tick after sign-in).
  teams: TeamsView | null;
  teamsBusy: boolean;
  teamsError: string | null;
  // The invite step shows after starting a sync, until Done.
  inviteOpen: boolean;
  // Teams audio fallback (core/teams-audio.ts): main's status (support, Teams call, coverage; codes only, null until the first
  // poll), and whether Bee hears the Teams app now. failed: the capture would not open or ended in this call; Bee carries on
  // with the mic and tries again in the next call. failure: why (core/teams-audio-protocol.ts), for the Settings line.
  teamsAudio: { status: TeamsAudioStatus | null; listening: boolean; failed: boolean; failure: TeamsAudioFailure | null };
  // Computer use in progress (null when none), and what macOS allows it, for Settings (null until asked).
  computer: ComputerView | null;
  computerAccess: ComputerAccessView | null;
  // The conversation window after a request to Bee (core/wake-word.ts CONVERSATION_WINDOW_MS): a follow-up needs no "Bee". The
  // pill says Bee is listening. State only, never words.
  conversationOpen: boolean;
};

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
// Main throttles its own title and calendar reads, so this poll only asks for the cached view.
const MEETING_TICK_MS = 5000;
// Lines kept, island dismissed and no new line for this long: the meeting is saved without a click.
const DISMISS_FINALIZE_MS = 10 * 60_000;
// With the mic on, a caption that repeats one of the user's own lines from this long ago is the same speech twice.
const CAPTION_ECHO_MS = 20_000;
// Caption lines with no speaker label.
const CAPTION_SPEAKER = "Meeting";
// After a direct request's reply lands ("Bee, open Teams"), meeting lines wait this long before they start a turn, so the
// reply can be read. Closing the island ends the wait.
const COMMAND_HOLD_MS = 8000;

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
  keptTips: [],
  revising: false,
  tipSources: {},
  question: false,
  tools: [],
  done: false,
  dismissed: false,
  islandClosing: false,
  fullText: false,
  chips: [],
  dismissedChipIds: [],
  meeting: null,
  meetingCard: null,
  error: null,
  mic: { ...MIC_OFF, error: null },
  hint: null,
  hintClosing: false,
  update: { status: "idle", check: null, error: null },
  teams: null,
  teamsBusy: false,
  teamsError: null,
  inviteOpen: false,
  teamsAudio: { status: null, listening: false, failed: false, failure: null },
  computer: null,
  computerAccess: null,
  conversationOpen: false,
};
const listeners = new Set<() => void>();

function set(patch: Partial<BeeState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

/** Calls `listener` after every state change, in order (useBee; the E2E mic latency page times runs with it). */
export function subscribe(listener: () => void): () => void {
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
let captionSeq = 0;
let teamsAudioSeq = 0;
let turnSeq = 0;
let turnText = "";
// Live steering. A turn is a line and those that interrupt its run (core/steering.ts isNewTurn); inside it a new line keeps
// the tips on screen. A dismissal closes it.
let turnOpen = false;
let lastLineAt = 0;
// A phrase ended while a run was busy; its line may land after the run settles and still steers it.
let spokenDuringRun = false;
// The line that opened this turn has not started a run yet: nothing is kept.
let pendingFresh = false;
// The line that opened this turn, so Luna answers only the turn's lines. lastAnswer: the latest settled tips; a new turn takes
// them as turnEarlier, context for a follow-up ("why…"). Only that one answer: older ones kept the model on an old subject.
let turnFirstId: string | null = null;
let lastAnswer: string[] = [];
let turnEarlier: string[] = [];
// A direct question came since the run in flight started (steering.ts isQuestion, waitsForRun).
let asked = false;
// Some line of the current turn is a direct question (BeeState.question).
let turnAsked = false;
// The latest answer, settled or streaming, came from a web search: a follow-up keeps the search tool (core/web-search.ts).
let answerSearched = false;
// A run is waiting out its debounce (runTimer), or waiting for a run in its commit window to finish (deferred).
let runTimer: ReturnType<typeof setTimeout> | undefined;
let doneTimer: ReturnType<typeof setTimeout> | undefined;
let deferred = false;
// The run in flight: its keep list, and the tips it has streamed so far (the last may be half written). runAnswering: a question
// came just before it started, so lines that are not questions wait for it instead of cancelling it.
let inFlight: number | null = null;
let runAnswering = false;
let runKept: string[] = [];
let runTips: string[] = [];
let restarts: number[] = [];
let stopMic: (() => void) | null = null;
// The wake word (core/wake-word.ts). "Bee" alone arms it: the next mic phrase before this time is the request.
let wakeArmedUntil = 0;
// The direct request in flight (its run number), the wait after its reply (COMMAND_HOLD_MS), and the meeting lines with
// content that came meanwhile: they start their turn when the wait ends.
let commandRun: number | null = null;
let commandHold: ReturnType<typeof setTimeout> | undefined;
let parkedLines: SessionLine[] = [];
// Bee's history (core/bee-history.ts): the last few requests and what Bee did, sent with each new request as earlier turns.
// Separate from the meeting session: never in the summary, meeting memory or the Teams sync. Cleared after HISTORY_IDLE_MS
// with no exchange, and when the meeting ends.
let history: BeeExchange[] = [];
let historyTimer: ReturnType<typeof setTimeout> | undefined;
// The conversation window after a request (BeeState.conversationOpen): when it ends, Bee's last exchange for the routing and
// the follow-up check, when the last exchange ended, and when someone else (caption, Teams audio, teammate) was last heard.
let conversationUntil = 0;
let conversationTimer: ReturnType<typeof setTimeout> | undefined;
let lastBee: { request: string; reply: string } | null = null;
let lastExchangeAt = 0;
let lastOtherSpeakerAt = 0;
// "Bee, stop" for this run: its result opens no conversation window.
let stoppedRun: number | null = null;
// The Teams audio capture while it runs, and guards while it opens and while main is asked for its status.
let stopTeamsAudio: (() => void) | null = null;
let teamsAudioOpening = false;
let teamsAudioTicking = false;
let sentSize: WindowSize = "collapsed";
let ticking = false;
let islandHovered = false;
let scrollLoggedAt = 0;
// Meeting context. The detected meeting the session's lines belong to (null: none was detected, so only a click saves it),
// and the last meeting whose card was shown.
let sessionMeetingId: number | null = null;
let cardShownFor = 0;
let meetingTicking = false;
let islandActivityAt = 0;
let islandTimer: ReturnType<typeof setTimeout> | undefined;
// Mic hints: one detector for the app, so a hint's cooldown outlasts a mic toggle. Fed by each mic frame and phrase outcome.
const hintDetector = createHintDetector({ enabled: false });
let hintShownAt = 0;
const EMPTY_RESULT = { tips: [], guideError: null };
const STOPPED_RESULT: PipelineResult = {
  notes: [],
  rankSource: "fallback",
  rankError: null,
  tips: ["Stopped."],
  tipSources: [null],
  sources: [],
  guideError: null,
  timingsMs: { retrieve: 0, rank: 0, guide: 0, mcp: 0, lunaFirstToken: null, lunaTotal: 0 },
};

/**
 * What the island and panel show: the last result, with the streamed tips over it while a run is in flight.
 * Old tips stay visible while busy. An old error and notes do not, and streamed tips drop the old sources.
 */
export function displayResult(current: Pick<BeeState, "result" | "partialTips" | "busy" | "tipSources">): PipelineResult | null {
  const { result, partialTips, busy } = current;
  const shown: PipelineResult | null = partialTips
    ? { ...(result ?? { notes: [], rankSource: "fallback", rankError: null, timingsMs: ZERO_TIMINGS }), tips: partialTips, sources: [], guideError: null, guideNote: null, mcpErrors: [] }
    : result && busy
      ? { ...result, guideError: null, guideNote: null, mcpErrors: [] }
      : result;
  return shown && { ...shown, tipSources: sourcesOf(current.tipSources, shown.tips) };
}

/** Each tip's source from the turn's map, by position (BeeState.tipSources). */
const sourcesOf = (known: Record<string, string>, tips: readonly string[]) => tips.map((tip) => known[tipKey(tip)] ?? null);

/** The turn's map with a result's or a partial's sources added, by tip text. A tip without one keeps any it had. */
function withSources(known: Record<string, string>, update: { tips: string[]; tipSources?: (string | null)[] }): Record<string, string> {
  const added = update.tips.flatMap((tip, index): [string, string][] => {
    const source = update.tipSources?.[index];
    return source ? [[tipKey(tip), source]] : [];
  });
  return added.length > 0 ? { ...known, ...Object.fromEntries(added) } : known;
}

const ZERO_TIMINGS = { retrieve: 0, rank: 0, guide: 0, mcp: 0, lunaFirstToken: null, lunaTotal: 0 };

/** The words the island body shows, for its reading time (island.ts islandOpenMs). */
function islandText(current: BeeState): string {
  const result = displayResult(current);
  return [...(current.meetingCard?.lines ?? []), ...(result?.tips ?? []), result?.guideError ?? ""].join(" ");
}

/**
 * Restart the inactivity clock. The body folds back to the pill's one line islandOpenMs after the last result, scroll or pointer
 * leave: at least 30 s plus reading time. An answer the user opened in full never folds on its own.
 */
function touchIsland(): void {
  islandActivityAt = Date.now();
  clearTimeout(islandTimer);
  if (!responseOpen(state) || islandHovered || state.fullText) return;
  islandTimer = setTimeout(autoCollapseIsland, islandOpenMs(islandText(state)));
}

function autoCollapseIsland(): void {
  // A hint goes by itself (hints.ts). Fold the response once it has, so the body does not close and then reopen for the hint.
  if (state.hint && responseOpen(state)) {
    islandTimer = setTimeout(autoCollapseIsland, HINT_SHOW_MS);
    return;
  }
  // Chips can hold the body open while Luna thinks; the pill's phase then stays "thinking" and nothing collapses.
  const phase = state.busy ? "thinking" : responseOpen(state) ? "expanded" : "idle";
  const openMs = islandOpenMs(islandText(state));
  if (shouldAutoCollapse({ phase, hovered: islandHovered, fullText: state.fullText, lastActivityAt: islandActivityAt, now: Date.now(), openMs })) {
    debugLog.debug("ui", "auto-collapse", { openMs, idleMs: Date.now() - islandActivityAt });
    void closeIsland();
  }
}

async function closeIsland(): Promise<void> {
  if (!responseOpen(state) || state.islandClosing) return;
  set({ islandClosing: true });
  await new Promise((resolve) => setTimeout(resolve, motionReduced() ? REDUCED_EXIT_MS : ISLAND_CLOSE_MS));
  if (!state.islandClosing) return;
  // Dismissed tips are a finished turn: the next line starts afresh. A run in flight carries on.
  turnOpen = false;
  set({ dismissed: true, islandClosing: false, fullText: false, meetingCard: null });
  // A direct request's reply was closed: meeting lines that waited for it go now.
  if (commandHold !== undefined) endCommandHold();
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

/**
 * The island body shows a response (tips, link chips, the meeting card): something to show, and no panel or sync card in the
 * way. A Confirm prompt for computer use always shows, over a sync card.
 */
export function responseOpen(current: BeeState): boolean {
  if (current.expanded) return false;
  if (current.computer?.confirm) return true;
  if (syncCard(current)) return false;
  return islandShowsBody(islandArgs(current));
}

/** The island body is open: for a response, or for a mic hint alone (a hint shows even after the response was closed). */
export function islandOpen(current: BeeState): boolean {
  if (current.expanded || syncCard(current)) return false;
  return current.hint !== null || responseOpen(current);
}

/**
 * Shows the detector's hint, or folds the one on screen once the detector drops it (timed out, speech heard, setting off). Logs
 * the hint's id and time on screen only, never levels or words.
 */
function syncHint(hint: Hint | null): void {
  if ((hint?.id ?? null) === (state.hint?.id ?? null)) return;
  if (!hint) {
    void hideHint();
    return;
  }
  hintShownAt = Date.now();
  console.debug(`Bee: mic hint ${hint.id}`);
  set({ hint: { id: hint.id, text: hint.text }, hintClosing: false });
  void applyWindowSize();
}

/** The hint plays its exit, then goes. With nothing else in the body, the body closes with it, like the dismiss button. */
async function hideHint(): Promise<void> {
  const hint = state.hint;
  if (!hint || state.hintClosing) return;
  set({ hintClosing: true });
  await new Promise((resolve) => setTimeout(resolve, motionReduced() ? REDUCED_EXIT_MS : ISLAND_CLOSE_MS));
  if (state.hint?.id !== hint.id || !state.hintClosing) return;
  console.debug(`Bee: mic hint ${hint.id} hidden after ${Math.round((Date.now() - hintShownAt) / 1000)} s`);
  set({ hint: null, hintClosing: false });
  await applyWindowSize();
}

/** Feeds one mic frame to the hint detector while the setting is on. Numbers only: the frame itself goes no further. */
function hintFrame(level: number, frame: Float32Array): void {
  const enabled = state.settings?.hintsEnabled === true;
  hintDetector.setEnabled(enabled);
  syncHint(enabled ? hintDetector.push({ now: Date.now(), level, peak: framePeak(frame), micOn: true }) : null);
}

/**
 * The pill shows an answer folded to one line (the body is closed, nothing is running or being heard): a click on it opens the
 * answer in full in the island (island.ts islandClick).
 */
export function answerFolded(current: BeeState): boolean {
  if (current.busy || current.heard) return false;
  return shouldShowResponse({ ...islandArgs(current), dismissed: false });
}

/** What island.ts needs from the state: the result (or an empty one), the chips still shown, and the flags. */
export function islandArgs(current: BeeState) {
  return {
    ...(displayResult(current) ?? EMPTY_RESULT),
    chipCount: visibleChips(current.chips, current.dismissedChipIds).length,
    cardLines: current.meetingCard?.lines.length ?? 0,
    dismissed: current.dismissed,
    busy: current.busy,
    revising: current.revising,
  };
}

/** Resize the window to fit: full panel, notch plus sync card, notch plus island body, or notch only. */
async function applyWindowSize(): Promise<void> {
  const size: WindowSize =
    state.expanded && !state.collapsing ? "expanded" : state.computer?.confirm ? "response" : syncCard(state) ? "prompt" : islandOpen(state) ? "response" : "collapsed";
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

/**
 * Adds lines to the session. A line with content words starts or extends a turn; one without ("yeah", "okay") only joins the
 * transcript. Returns true when a run should follow.
 */
function addLines(lines: SessionLine[]): boolean {
  // Other people's lines never open the conversation window; they only mark that someone else spoke.
  if (lines.some((line) => !line.own)) lastOtherSpeakerAt = Date.now();
  const current = state.session.lines;
  if (current.length === 0) sessionMeetingId = state.meeting?.active ? state.meeting.id : null;
  // A teammate's or caption line that repeats a recent Teams-audio line replaces it: it names the speaker. Its words are
  // already in, so it starts no turn of its own.
  const replaced = teamsAudioReplaced(current, lines);
  const gone = new Set(replaced.map((entry) => entry.id));
  const replacing = new Set(replaced.map((entry) => entry.by));
  const before = gone.size > 0 ? current.filter((line) => !gone.has(line.id)) : current;
  const merged = mergeLines(before, lines, SESSION_TRANSCRIPT_MAX);
  set({ session: { ...state.session, lines: merged } });
  // Lines already seen start no turn.
  if (merged === before) return false;
  const content = lines.filter((line) => !isFiller(line.text) && !replacing.has(line.id));
  if (content.length === 0) return false;
  // A direct request's reply holds the island: the lines are in the session now, and start their turn when it lets go.
  if (commandRun !== null || commandHold !== undefined) {
    parkedLines = [...parkedLines, ...content];
    return false;
  }
  startTurn(content);
  return true;
}

/**
 * Asks main to personalise chips (exact page from history, or drop one). Chips stay as they are on any failure or when the turn
 * has moved on. Chips not sent (added since) are kept. Main sends text to vmem and Jev only with the setting on.
 */
async function enrichChips(sent: LinkChip[], text: string, seq: number): Promise<void> {
  if (sent.length === 0 || !state.settings?.personalisedLinks) return;
  try {
    const reply = await window.bee.enrichLinks({ turn: text.slice(0, 4000), chips: sent });
    debugLog.info("links", "enriched", { sent: sent.map((chip) => chip.url), kept: reply.chips.map((chip) => chip.url) });
    if (seq !== turnSeq) return;
    const sentIds = new Set(sent.map((chip) => chip.id));
    const byId = new Map(reply.chips.map((chip) => [chip.id, chip]));
    set({ chips: state.chips.flatMap((chip) => (sentIds.has(chip.id) ? (byId.has(chip.id) ? [byId.get(chip.id) as LinkChip] : []) : [chip])) });
    void applyWindowSize();
  } catch {
    // Plain chips stay.
  }
}

/**
 * New spoken or simulated lines with content. Chips from their links open the island body even before Luna answers. A line that
 * interrupts a run steers it: the chips merge and turnSeq stays, so enrichChips for earlier chips is not dropped. Any other line
 * starts afresh: the last answer, its chips and the full-text view go at once, so only the new answer shows.
 */
function startTurn(lines: SessionLine[]): void {
  const fresh = isNewTurn({ open: turnOpen, busy: state.busy, spokenDuringRun });
  const question = lines.some((line) => isQuestion(line.text));
  if (question) asked = true;
  turnAsked = (!fresh && turnAsked) || question;
  spokenDuringRun = false;
  turnOpen = true;
  lastLineAt = Date.now();
  const text = lines.map((line) => line.text).join("\n");
  const found = mergeChips([], lines.flatMap((line) => detectLinks(line.text)));
  if (fresh) {
    pendingFresh = true;
    turnFirstId = lines[0]?.id ?? null;
    turnEarlier = lastAnswer.slice(-MAX_STEERING_TIPS).map(clampTip);
    const seq = ++turnSeq;
    turnText = text;
    void enrichChips(found, turnText, seq);
    const cleared = { result: null, partialTips: null, tipSources: {}, fullText: false, chips: found, dismissedChipIds: [] };
    set(found.length > 0 ? { ...cleared, dismissed: false, islandClosing: false } : cleared);
    clearTimeout(islandTimer);
    if (found.length > 0) touchIsland();
    void applyWindowSize();
    return;
  }
  turnText = `${turnText}\n${text}`;
  const chips = mergeChips(state.chips, found);
  const added = chips.filter((chip) => !state.chips.some((known) => known.id === chip.id));
  void enrichChips(added, turnText, turnSeq);
  if (added.length === 0) return;
  set({ chips, dismissed: false, islandClosing: false });
  touchIsland();
  void applyWindowSize();
}

/**
 * The tips a run starts from: those on screen, complete lines only. A run in flight has streamed its tips; the last may be half
 * written, so it is dropped. Nothing is kept for the first line of a turn.
 */
function keepList(): string[] {
  if (pendingFresh) return [];
  if (inFlight !== null) {
    const max = tipCap(runKept.length);
    return runTips.length > 0 ? mergeTips(runKept, runTips.slice(0, -1), max, false) : runKept;
  }
  return state.result?.tips ?? [];
}

/** A line with content arrived: start at once for the first line of a turn; otherwise debounce, or pause once restarts pile up. */
function scheduleRun(): void {
  // A run waits for the one in flight; it reads the whole transcript when it starts, so this line is already in. A new turn or a
  // new question is weighed again in fireRun: it may supersede that run.
  if (deferred && !pendingFresh && !asked) return;
  deferred = false;
  clearTimeout(runTimer);
  const keep = keepList();
  // Busy from now, so the pill shows the working state at once (notch.ts workingLabel), before the run streams anything.
  set({ busy: true, heard: false, question: turnAsked, keptTips: keep, revising: keep.length > 0 });
  const steering = keep.length > 0 || inFlight !== null;
  runTimer = setTimeout(fireRun, runDelayMs(restarts, Date.now(), steering));
}

function fireRun(): void {
  runTimer = undefined;
  // Nearly done, or answering a question no newer question replaces: let the answer finish, then start. A new turn has nothing worth finishing.
  if (inFlight !== null && waitsForRun({ fresh: pendingFresh, runTips: runTips.length, answering: runAnswering, asked })) {
    deferred = true;
    return;
  }
  void runPipeline();
}

/**
 * Retrieve → Jev → Luna on the last 8 lines, teammates' lines labelled "Alice: …". Tips already on screen go to Luna as a keep
 * list; the run's tips merge over them (core/steering.ts mergeTips), so a newer line adds to the answer instead of wiping it.
 */
/** The list less one copy of `item`: a tool call ended, and another call to the same tool may still run. */
function withoutOne(list: string[], item: string): string[] {
  const at = list.indexOf(item);
  return at < 0 ? list : [...list.slice(0, at), ...list.slice(at + 1)];
}

/** Shows the logo's done state once, then lets it rest. */
function celebrate(): void {
  clearTimeout(doneTimer);
  set({ done: true });
  doneTimer = setTimeout(() => set({ done: false }), LOGO_DONE_MS);
}

async function runPipeline(): Promise<void> {
  const recent = state.session.lines.slice(-PIPELINE_WINDOW);
  const transcript = recent.map(pipelineText);
  if (transcript.length === 0) return;
  // The turn's lines, newest last. Its first line out of the window: the whole window is the turn.
  const turnStart = recent.findIndex((line) => line.id === turnFirstId);
  const turnLines = recent.length - Math.max(0, turnStart);
  const fresh = pendingFresh;
  const keep = keepList();
  // A new turn drops the last answer from the screen, but Luna still gets it, so a follow-up ("why…") has its context.
  const earlier = keep.length > 0 ? [] : turnEarlier;
  const cap = tipCap(keep.length);
  const now = Date.now();
  // A run still in flight is cancelled below: that is a restart.
  if (inFlight !== null) restarts = [...recentRestarts(restarts, now), now];
  const previous = latestRun;
  const run = ++latestRun;
  // A newer line supersedes the run in flight: stop its Jev and Luna in main. Fire and forget. A started tool call is never aborted.
  if (previous > 0) void window.bee.cancelPipeline({ runId: previous }).catch(() => undefined);
  pendingFresh = false;
  deferred = false;
  inFlight = run;
  runAnswering = asked;
  asked = false;
  runKept = keep;
  runTips = [];
  const searched = answerSearched;
  let searchedRun = false;
  const started = performance.now();
  let partials = 0;
  let firstPartialMs: number | null = null;
  debugLog.info("ai", "run-start", { run, cancelled: previous > 0 ? previous : null, lines: transcript.length, turnLines, kept: keep, earlier, searched, fresh, restarts: restarts.length });
  // The kept tips stay on screen (dimmed, pill "Updating…"). A new turn drops the old answer.
  set({
    busy: true,
    heard: false,
    tools: [],
    done: false,
    error: null,
    keptTips: keep,
    revising: keep.length > 0,
    partialTips: keep.length > 0 ? keep : null,
    ...(fresh ? { result: null } : {}),
  });
  void applyWindowSize();
  // The latest run owns tool events (and the run id, when sent, must match). Finishing clears the label and the calls.
  const stopActivity = window.bee.onLunaActivity(({ runId, tool, phase }) => {
    if (run !== latestRun || (runId !== undefined && runId !== run)) return;
    debugLog.debug("ai", "tool", { run, tool, phase });
    if (phase === "start" && tool === "web_search") searchedRun = answerSearched = true;
    if (phase === "start") set({ tools: [...state.tools, tool] });
    else set({ tools: withoutOne(state.tools, tool) });
  });
  // Streamed tips show at once, over the kept ones, without waiting for the whole run.
  const stopPartial = window.bee.onLunaPartial((partial) => {
    if (run !== latestRun || (partial.runId !== undefined && partial.runId !== run)) return;
    const { tips } = partial;
    partials += 1;
    if (firstPartialMs === null) {
      firstPartialMs = Math.round(performance.now() - started);
      debugLog.info("ai", "run-first-tips", { run, ms: firstPartialMs, tips });
    }
    runTips = tips;
    set({
      partialTips: keep.length > 0 ? mergeTips(keep, tips, cap, false) : tips,
      tipSources: withSources(state.tipSources, partial),
      dismissed: false,
      islandClosing: false,
    });
    touchIsland();
    void applyWindowSize();
  });
  try {
    const result = await window.bee.runPipeline({
      transcript,
      runId: run,
      ...(keep.length > 0 ? { shown: keep.map(clampTip) } : {}),
      ...(earlier.length > 0 ? { earlier } : {}),
      turnLines,
      ...(searched ? { searched } : {}),
      sessionToken: await sessionToken(),
    });
    if (run !== latestRun) {
      debugLog.info("ai", "run-superseded", { run, latest: latestRun, ms: Math.round(performance.now() - started) });
      return;
    }
    // Another run follows (a line is in its debounce, or waits for this run): the answer is not settled yet.
    const waiting = runTimer !== undefined || deferred;
    // The run returns the full set. A tip it left out was replaced. No tips at all (NONE, an error) leaves the kept ones.
    const tips = keep.length > 0 ? mergeTips(keep, result.tips, cap, true) : result.tips;
    const tipSources = withSources(state.tipSources, result);
    const shown = { ...result, tips, tipSources: sourcesOf(tipSources, tips) };
    // The tips' links join this turn's chips, then the search sources (deduped, capped). Sources are exact pages already, so only
    // the tips' links are personalised.
    const linked = mergeChips(state.chips, tips.flatMap((tip) => detectLinks(tip)));
    const added = linked.filter((chip) => !state.chips.some((known) => known.id === chip.id));
    void enrichChips(added, [turnText, ...tips].join("\n"), turnSeq);
    const chips = mergeChips(linked, sourceChips(result.sources));
    debugLog.info("ai", "run-result", {
      run,
      ms: Math.round(performance.now() - started),
      firstPartialMs,
      partials,
      waiting,
      tips,
      tipSources: shown.tipSources,
      sources: result.sources,
      chips: chips.map((chip) => chip.url),
      guideError: result.guideError,
      guideNote: result.guideNote ?? null,
      rankError: result.rankError,
      mcpErrors: result.mcpErrors ?? [],
      timingsMs: result.timingsMs,
    });
    set({
      result: shown,
      partialTips: null,
      tipSources,
      chips,
      busy: waiting,
      keptTips: waiting ? tips : [],
      revising: waiting && tips.length > 0,
      tools: [],
      dismissed: false,
      islandClosing: false,
    });
    if (!waiting) {
      addToSession(shown);
      answerSearched = searchedRun || result.sources.length > 0;
    }
    if (!waiting && tips.length > 0) {
      lastAnswer = tips;
      celebrate();
    }
    touchIsland();
  } catch (error) {
    debugLog.warn("ai", "run-failed", { run, latest: latestRun, ms: Math.round(performance.now() - started), error: errorData(error) });
    if (run === latestRun) {
      set({
        busy: runTimer !== undefined || deferred,
        keptTips: [],
        revising: false,
        partialTips: null,
        tools: [],
        error: error instanceof Error ? error.message : "Pipeline failed",
      });
    }
  } finally {
    stopActivity();
    stopPartial();
    if (run === latestRun) {
      inFlight = null;
      // A line came while this run was nearly done: start its run now, from the settled tips.
      if (deferred) {
        deferred = false;
        void runPipeline();
      }
    }
    void applyWindowSize();
  }
}

/** The direct request's wait is over: lines that came meanwhile start their turn, as if they had just arrived. */
// A meeting line that starts like the wake word ("Be careful", "B could", "Bees…", "Hey, be…"), for the debug log only.
const NEAR_WAKE = /^\W*(?:hey\W+|hi\W+|ok\W+)?(?:b|be|bee|bea|bees|been|beep|bean|bey|bae)\b/i;

function endCommandHold(): void {
  clearTimeout(commandHold);
  commandHold = undefined;
  if (commandRun !== null) return;
  const lines = parkedLines;
  parkedLines = [];
  if (lines.length === 0) return;
  startTurn(lines);
  scheduleRun();
}

/** Names of other people in this meeting (captions, teammates, the sync's roster): a phrase that names one is for them. */
function participantNames(): string[] {
  const names = new Set<string>();
  for (const line of state.session.lines) if (!line.own && line.speakerName !== CAPTION_SPEAKER && line.speakerName !== TEAMS_AUDIO_SPEAKER) names.add(line.speakerName);
  for (const member of state.teams?.roster ?? []) if (member.userId !== state.teams?.me?.userId) names.add(member.displayName);
  return [...names];
}

/**
 * Opens (or restarts) the conversation window after an exchange with Bee: CONVERSATION_WINDOW_MS, or CONVERSATION_QUESTION_MS
 * while Bee's reply asks a question. It closes on silence, "thanks", "Bee, stop", a reply to someone else, a participant's
 * name, the island's dismiss button or the end of the meeting (closeConversation).
 */
function openConversation(): void {
  const ms = lastBee?.reply.includes("?") ? CONVERSATION_QUESTION_MS : CONVERSATION_WINDOW_MS;
  conversationUntil = Date.now() + ms;
  clearTimeout(conversationTimer);
  conversationTimer = setTimeout(() => closeConversation("silence"), ms);
  debugLog.info("wake", "conversation-open", { ms, question: ms === CONVERSATION_QUESTION_MS });
  if (!state.conversationOpen) set({ conversationOpen: true });
}

function closeConversation(reason: string): void {
  clearTimeout(conversationTimer);
  conversationTimer = undefined;
  const open = conversationUntil > 0;
  conversationUntil = 0;
  if (!open) return;
  debugLog.info("wake", "conversation-closed", { reason });
  if (state.conversationOpen) set({ conversationOpen: false });
}

/** One more exchange in Bee's history, and the idle clock restarts. */
function rememberExchange(exchange: BeeExchange): void {
  history = addExchange(liveHistory(history, exchange.at), exchange);
  lastBee = { request: exchange.request, reply: [exchange.reply, ...(exchange.actions ?? [])].filter(Boolean).join(" ") };
  lastExchangeAt = exchange.at;
  clearTimeout(historyTimer);
  historyTimer = setTimeout(() => clearHistory("idle"), HISTORY_IDLE_MS);
}

function clearHistory(reason: string): void {
  clearTimeout(historyTimer);
  historyTimer = undefined;
  if (history.length > 0) debugLog.info("wake", "history-cleared", { reason, exchanges: history.length });
  // An idle clear ends a conversation: main may send it to vmem (it checks the setting and holds the connector's secrets).
  // Not on meeting-end: the meeting's own send covers that session.
  if (reason === "idle" && history.length > 0 && (state.settings?.sendSessionsToVmem ?? false)) sendConversation(history);
  history = [];
  lastBee = null;
}

/** Fire and forget: a failure is logged and never reaches the user. */
function sendConversation(exchanges: readonly BeeExchange[]): void {
  void (async () => {
    try {
      await window.bee.conversationEnded({ exchanges: [...exchanges], sessionToken: await sessionToken() });
    } catch (error) {
      debugLog.warn("vmem", "conversation-send-failed", { error: errorData(error) });
    }
  })();
}

/** Bee's history as it stands now, oldest first (tests). */
export function beeHistory(): BeeExchange[] {
  return liveHistory(history, Date.now());
}

/**
 * A mic phrase that starts with the wake word ("Bee, open Teams") is a request to the AI, not a meeting line: it never joins
 * the session, the summary, meeting memory or the Teams sync. "Bee" alone arms the next phrase. In the conversation window, a
 * phrase without "Bee" that looks addressed to Bee is a follow-up; an unclear one may get one small AI check (followUpCheck).
 * Returns true when the phrase was taken. Console lines never carry the words; the local debug log does.
 */
function takeWakeLine(text: string): boolean {
  const now = Date.now();
  const enabled = state.settings?.wakeWordEnabled ?? true;
  const armed = now < wakeArmedUntil;
  const conversationOpen = enabled && now < conversationUntil && commandRun === null;
  const othersSpoke = lastOtherSpeakerAt > lastExchangeAt;
  const route = routeLine({ text, source: "mic", enabled, armed, conversationOpen, lastBee, participants: participantNames(), othersSpoke });
  wakeArmedUntil = route.kind === "wake" ? now + WAKE_FOLLOW_MS : 0;
  // The local debug log keeps the words that woke Bee, and the meeting lines that nearly did (a likely miss or false trigger).
  if (route.kind !== "meeting" || NEAR_WAKE.test(text) || conversationOpen) {
    debugLog.info("wake", route.kind === "meeting" ? "near-miss" : route.kind, { text, route, enabled, armed, conversationOpen, othersSpoke });
  }
  if (route.kind === "meeting") {
    // A reply to someone else, or a name from the meeting: the user has turned back to the meeting.
    if (conversationOpen && (route.reason === "reply-to-others" || route.reason === "names-participant")) closeConversation(route.reason);
    return false;
  }
  console.debug(`Bee: wake ${route.kind}`);
  if (route.kind === "close") {
    closeConversation("thanks");
    return true;
  }
  if (route.kind === "unclear") return followUpCheck(text);
  // Only a tap answers a Confirm prompt. "Bee, yes, send it" leaves the prompt as it is, rather than cancelling the task.
  if (route.kind === "command" && state.computer?.confirm && isConfirmWords(route.command)) {
    debugLog.info("wake", "confirm-words-ignored", { command: route.command, confirm: state.computer.confirm.id });
    set({ computer: { ...state.computer, step: "Tap Confirm to go ahead…" } });
    return true;
  }
  if (route.kind === "command") void runCommand(route.command);
  // "Bee, stop" ends the request in flight, if any, and the conversation. Nothing else happens.
  if (route.kind === "stop") {
    stoppedRun = commandRun;
    closeConversation("stop");
    void stopCommand();
  }
  return true;
}

/**
 * An unclear phrase in the conversation window: one small AI call (main, core/follow-up.ts) decides whether it is for Bee.
 * The phrase waits for it, then becomes a follow-up or a meeting line. Without the call (older preload) or on any failure it
 * is a meeting line at once. Only reached from the user's own mic.
 */
function followUpCheck(text: string): boolean {
  const classify = window.bee.classifyFollowUp;
  const bee = lastBee;
  if (typeof classify !== "function" || !bee) {
    debugLog.info("wake", "follow-up-unchecked", { reason: bee ? "no classifier" : "no exchange" });
    return false;
  }
  const lines = state.session.lines.slice(-3).map((line) => `${line.own ? "me" : "them"}: ${line.text}`);
  const othersQuiet = Date.now() - lastOtherSpeakerAt >= OTHERS_QUIET_MS;
  void (async () => {
    const verdict = await sessionToken()
      .then((token) => classify({ phrase: text.slice(0, 1000), lastBee: bee, lines, othersQuiet, sessionToken: token }))
      .catch(() => null);
    const forBee = isForBee(verdict) && conversationUntil > 0;
    debugLog.info("wake", "follow-up-checked", { text, verdict, forBee, othersQuiet });
    if (forBee) void runCommand(text);
    else addOwnLine(text, "mic");
  })();
  return true;
}

/**
 * Stops the direct request in flight: computer use ends in main ("Stopped." comes back as its line); an answer is dropped and
 * "Stopped." shows at once. Only the user's own mic ("Bee, stop") and the island's Stop button call this.
 */
async function stopCommand(): Promise<void> {
  const run = commandRun;
  debugLog.info("computer", "stop", { run, computer: state.computer?.runId === run });
  if (run === null) return;
  if (state.computer?.runId === run) {
    set({ computer: { ...state.computer, step: "Stopping…", confirm: null } });
    void applyWindowSize();
    await window.bee.stopCommand({ runId: run }).catch(() => undefined);
    return;
  }
  // No computer use: the answer is not worth waiting for.
  latestRun += 1;
  commandRun = null;
  void window.bee.stopCommand({ runId: run }).catch(() => undefined);
  set({ busy: false, tools: [], partialTips: null, computer: null, result: { ...STOPPED_RESULT }, dismissed: false, islandClosing: false });
  commandHold = setTimeout(endCommandHold, COMMAND_HOLD_MS);
  touchIsland();
  void applyWindowSize();
}

/**
 * Runs a direct request in main (core/direct-command.ts) and shows the reply in the island as the answer to the user: action
 * lines first ("Opened Teams"), then the AI's reply. It takes the island like a new turn: the meeting run in flight is dropped
 * (its lines stay in the session), and meeting lines wait until the reply has been on screen for COMMAND_HOLD_MS. The reply is
 * not a meeting answer: it is not kept for the summary or meeting memory, nor sent as context for later tips. It does go into
 * Bee's own history (rememberExchange), sent with the next requests as earlier turns, and opens the conversation window.
 */
async function runCommand(command: string): Promise<void> {
  const previous = latestRun;
  const run = ++latestRun;
  const started = performance.now();
  debugLog.info("ai", "command-start", { run, command, cancelled: previous > 0 ? previous : null });
  if (previous > 0) void window.bee.cancelPipeline({ runId: previous }).catch(() => undefined);
  clearTimeout(runTimer);
  runTimer = undefined;
  deferred = false;
  inFlight = null;
  runKept = [];
  runTips = [];
  pendingFresh = false;
  turnOpen = false;
  commandRun = run;
  // The window reopens when this request is answered; while it runs, phrases without "Bee" are meeting lines.
  closeConversation("request");
  clearTimeout(commandHold);
  commandHold = undefined;
  clearTimeout(islandTimer);
  set({
    busy: true,
    heard: false,
    question: true,
    tools: [],
    done: false,
    error: null,
    keptTips: [],
    revising: false,
    result: null,
    partialTips: null,
    tipSources: {},
    fullText: false,
    chips: [],
    dismissedChipIds: [],
    dismissed: false,
    islandClosing: false,
  });
  void applyWindowSize();
  const stopActivity = window.bee.onLunaActivity(({ runId, tool, phase }) => {
    if (run !== latestRun || (runId !== undefined && runId !== run)) return;
    set({ tools: phase === "start" ? [...state.tools, tool] : withoutOne(state.tools, tool) });
  });
  const stopPartial = window.bee.onLunaPartial((partial) => {
    if (run !== latestRun || (partial.runId !== undefined && partial.runId !== run)) return;
    set({ partialTips: partial.tips, tipSources: withSources(state.tipSources, partial), dismissed: false, islandClosing: false });
    touchIsland();
    void applyWindowSize();
  });
  // Computer use: the step line, and a Confirm prompt that opens the island (the panel folds so the island shows it).
  const stopComputer = window.bee.computer.onUpdate((update) => {
    if (run !== latestRun || update.runId !== run) return;
    debugLog.info("computer", "update", { ...update });
    const step = update.type === "step" ? update.label : (state.computer?.step ?? "");
    set({ computer: { runId: run, step, confirm: update.type === "confirm" ? update : null }, dismissed: false, islandClosing: false });
    if (update.type === "confirm" && state.expanded) void actions.setExpanded(false);
    touchIsland();
    void applyWindowSize();
  });
  try {
    // The meeting so far, as background for a request about it ("what did Priya just say").
    const recent = state.session.lines.slice(-PIPELINE_WINDOW).map(pipelineText);
    // Bee's history: earlier turns for the AI, so "the team one" follows on from the last request.
    const earlier = liveHistory(history, Date.now());
    const reply = await window.bee.runCommand({
      command: command.slice(0, COMMAND_MAX_CHARS),
      ...(recent.length > 0 ? { transcript: recent } : {}),
      ...(earlier.length > 0 ? { history: earlier } : {}),
      runId: run,
      sessionToken: await sessionToken(),
    });
    debugLog.info("ai", "command-result", { run, latest: latestRun, ms: Math.round(performance.now() - started), tips: reply.tips, sources: reply.sources, guideError: reply.guideError, actions: reply.actions ?? [], endedWhere: reply.endedWhere ?? null, timingsMs: reply.timingsMs });
    if (run !== latestRun) return;
    // Main already fills in a line for a silent reply; this guards an older main. An error shows as itself.
    const result = reply.tips.length === 0 && !reply.guideError ? { ...reply, tips: [commandFallbackReply(command)], tipSources: [null] } : reply;
    const actionLines = new Set(result.actions ?? []);
    rememberExchange({
      request: command,
      reply: result.tips.filter((tip) => !actionLines.has(tip)).join(" "),
      ...(result.actions?.length ? { actions: result.actions } : {}),
      ...(result.endedWhere ? { endedWhere: result.endedWhere } : {}),
      ...(result.guideError ? { error: result.guideError } : {}),
      at: Date.now(),
    });
    const tipSources = withSources(state.tipSources, result);
    set({
      result: { ...result, tipSources: sourcesOf(tipSources, result.tips) },
      partialTips: null,
      tipSources,
      chips: mergeChips([], result.tips.flatMap((tip) => detectLinks(tip))),
      busy: false,
      tools: [],
      computer: null,
      dismissed: false,
      islandClosing: false,
    });
    if (result.tips.length > 0) celebrate();
    touchIsland();
  } catch (error) {
    debugLog.warn("ai", "command-failed", { run, latest: latestRun, ms: Math.round(performance.now() - started), error: errorData(error) });
    if (run === latestRun) {
      // Electron prefixes a handler's error with "Error invoking remote method …".
      const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, "") : "";
      set({ busy: false, partialTips: null, tools: [], computer: null, error: message || "The AI could not answer" });
      rememberExchange({ request: command, reply: "", error: message || "The AI could not answer", at: Date.now() });
    }
  } finally {
    stopActivity();
    stopPartial();
    stopComputer();
    if (commandRun === run) {
      commandRun = null;
      commandHold = setTimeout(endCommandHold, COMMAND_HOLD_MS);
      // A follow-up needs no "Bee" for a while, unless the user said "Bee, stop".
      if (stoppedRun !== run && run === latestRun) openConversation();
    }
    if (stoppedRun === run) stoppedRun = null;
    void applyWindowSize();
  }
}

/** The user's own line joins the meeting: the session, the sync (mic only) and, with content words, a run. */
function addOwnLine(text: string, source: "typed" | "mic"): void {
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
  const content = addLines([own]);
  if (source === "mic" && state.teams?.room) void shareLine(own);
  if (content) scheduleRun();
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
    // Teammates' lines follow the same steering rules as the user's own.
    if (lines.length > 0 && addLines(lines)) scheduleRun();
  } catch {
    // Main or the relay failed this tick; the next one tries again.
  } finally {
    ticking = false;
  }
}

/**
 * Asks main which meeting this is. A new meeting with something from before shows its card once. When the call ends (or a
 * different meeting begins), or Bee has been dismissed and quiet for a while, the session saves itself, if meeting memory is on.
 */
async function meetingTick(): Promise<void> {
  if (meetingTicking) return;
  meetingTicking = true;
  try {
    const token = await getToken().catch(() => null);
    if (!token) return;
    const view = await window.bee.meeting.context(token);
    set({ meeting: view });
    if (!view.enabled) return;
    if (state.session.lines.length > 0 && sessionMeetingId === null && view.active) sessionMeetingId = view.id;
    if (view.active && view.id !== cardShownFor && view.card.length > 0) {
      cardShownFor = view.id;
      set({ meetingCard: { id: view.id, lines: view.card }, dismissed: false, islandClosing: false });
      touchIsland();
      void applyWindowSize();
    }
    const lines = state.session.lines.length;
    if (sessionMeetingId === null || state.summary.saving) return;
    const over = !view.active || view.id !== sessionMeetingId;
    const quiet = state.dismissed && !state.busy && lines > 0 && Date.now() - lastLineAt >= DISMISS_FINALIZE_MS;
    if (lines === 0) {
      if (over) sessionMeetingId = null;
    } else if ((over || quiet) && state.settings?.meetingContextEnabled && state.settings.meetingMemoryEnabled) {
      void actions.endMeeting({ auto: true });
    }
  } catch {
    // Main failed this tick; the next one tries again.
  } finally {
    meetingTicking = false;
  }
}

async function sessionToken(): Promise<string> {
  const token = await getToken();
  if (!token) throw new Error("Sign in to Bee to get guidance.");
  return token;
}

async function transcribePhrase(audio: Uint8Array<ArrayBuffer>): Promise<TranscribeResult> {
  const started = performance.now();
  try {
    const result = await window.bee.transcribe({ audio, sessionToken: await sessionToken() });
    debugLog.info("stt", "mic-phrase", { bytes: audio.byteLength, ms: Math.round(performance.now() - started), text: result.text, error: result.error });
    return result;
  } catch (error) {
    debugLog.warn("stt", "mic-phrase-failed", { bytes: audio.byteLength, ms: Math.round(performance.now() - started), error: errorData(error) });
    throw error;
  }
}

function setUpdate(patch: Partial<UpdateState>): void {
  set({ update: { ...state.update, ...patch } });
}

function setSummary(patch: Partial<SummaryState>): void {
  set({ summary: { ...state.summary, ...patch } });
}

// Adds new items to the end, skipping ones already present (by key), and keeps the newest max.
function mergeUnique(list: string[], items: string[], max: number, key: (item: string) => string = (item) => item): string[] {
  const known = new Set(list.map(key));
  return [...list, ...items.filter((item) => !known.has(key(item)) && known.add(key(item)))].slice(-max);
}

/** Record the notes cited and the tips from a shown result. */
function addToSession(result: PipelineResult): void {
  const cited = result.notes.filter((note) => note.cite !== null).map((note) => note.title);
  const session = state.session;
  set({
    session: {
      ...session,
      notesCited: mergeUnique(session.notesCited, cited, SESSION_LIST_MAX),
      // Once per settled turn, by tip text: a restart that keeps a tip does not add it again.
      tips: mergeUnique(session.tips, result.tips, SESSION_LIST_MAX, tipKey),
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
    debugLog.warn("mcp", "change-failed", { error: errorData(error) });
    set({ mcp: { ...state.mcp, error: message || "Could not save the server" } });
    return false;
  }
}

function setTeamsAudio(patch: Partial<BeeState["teamsAudio"]>): void {
  set({ teamsAudio: { ...state.teamsAudio, ...patch } });
}

/** What the Teams audio fallback should do now, from the setting, main's status and the mic. */
export function teamsAudioNow(current: Pick<BeeState, "settings" | "teamsAudio" | "mic">): TeamsAudioPlan {
  const status = current.teamsAudio.status;
  return teamsAudioPlan({
    enabled: current.settings?.teamsAudioFallbackEnabled ?? false,
    supported: status?.supported ?? false,
    teamsCall: status?.teamsCall ?? false,
    micOn: current.mic.on,
    coverage: status?.coverage ?? "unknown",
  });
}

function endTeamsAudio(): void {
  const stop = stopTeamsAudio;
  stopTeamsAudio = null;
  stop?.();
  if (state.teamsAudio.listening) setTeamsAudio({ listening: false });
}

/**
 * Starts or stops Teams audio to match teamsAudioNow. It runs beside the mic, never mixed into it: main runs the Teams-only
 * helper with its own phrase segmenter and speech-to-text, and sends back text. Its lines are never shared with the sync. Any
 * failure leaves the mic, the sync and the pipeline alone.
 */
async function syncTeamsAudio(): Promise<void> {
  if (teamsAudioNow(state) !== "listen") {
    endTeamsAudio();
    // The call ended or the mic went off: the next call tries again.
    if (state.teamsAudio.failed) setTeamsAudio({ failed: false, failure: null });
    return;
  }
  if (stopTeamsAudio || teamsAudioOpening || state.teamsAudio.failed) return;
  teamsAudioOpening = true;
  try {
    const token = await getToken().catch(() => null);
    if (!token) return;
    const opened = await openTeamsAudio(token);
    if (!opened.capture) {
      // Main saw no reason to listen now (its status moved on): no failure, the next tick decides again.
      if (opened.failure === "refused") return;
      setTeamsAudio({ failed: true, failure: opened.failure });
      console.debug(`teams-audio open=0 ${opened.failure}`);
      return;
    }
    const capture = opened.capture;
    // The mic may have gone off, or the call ended, while it opened.
    if (teamsAudioNow(state) !== "listen") {
      capture.stop();
      return;
    }
    stopTeamsAudio = () => capture.stop();
    setTeamsAudio({ listening: true, failed: false, failure: null });
    console.debug("teams-audio open=1");
    capture.start(
      (texts) => actions.teamsAudioLines(texts),
      (failure) => {
        // Stopped by main: a failure (Teams closed, permission) is not retried in this call; a plain stop may restart.
        endTeamsAudio();
        if (failure) setTeamsAudio({ failed: true, failure });
        console.debug(`teams-audio end ${failure ?? "stopped"}`);
      },
    );
  } catch {
    endTeamsAudio();
    setTeamsAudio({ failed: true, failure: "failed" });
    console.debug("teams-audio open=0 failed");
  } finally {
    teamsAudioOpening = false;
  }
}

/** Main's Teams audio status, on the meeting tick, then start or stop to match. Signed out: no status, so no Teams audio. */
async function teamsAudioTick(): Promise<void> {
  if (teamsAudioTicking) return;
  teamsAudioTicking = true;
  try {
    const token = await getToken().catch(() => null);
    // Test stubs of window.bee may leave teamsAudio out.
    const status = token ? await window.bee.teamsAudio?.status(token) : null;
    setTeamsAudio({ status: status ?? null });
  } catch {
    // Main failed this tick; the last status stands until the next one.
  } finally {
    teamsAudioTicking = false;
  }
  await syncTeamsAudio();
}

/** What speech-to-text calls for each spoken phrase, in this order. Shared by the mic and the E2E mic (startTestMic). */
const phraseCallbacks = {
  // The phrase is over: show "Got it…" now, before speech-to-text. A cough never gets here.
  onSpeechEnd: () => {
    debugLog.debug("audio", "phrase-end", { pending: heardPending + 1, busy: state.busy });
    heardPending += 1;
    // Spoken over a run: the line steers it even if the run settles before speech-to-text is done.
    if (state.busy) spokenDuringRun = true;
    set({ heard: true });
  },
  // Same path as a typed line; latestRun drops results from superseded runs.
  onLine: (line: string) => void actions.simulateLine(line, "mic"),
  // After onLine, so busy is already set when the ack ends and the pill never falls back to "Listening…".
  onSettled: (outcome?: PhraseOutcome) => {
    heardPending = Math.max(0, heardPending - 1);
    if (heardPending === 0) spokenDuringRun = false;
    if (heardPending === 0 && state.heard) set({ heard: false });
    // Phrases with no words feed the noisy hint. Whether words came back, never the words; a failed call says nothing about noise.
    if (outcome === "words" || outcome === "empty") syncHint(hintDetector.phrase({ now: Date.now(), words: outcome === "words" }));
  },
};

/**
 * E2E only (test/e2e/conversation-page.ts): the mic is on with no capture, and phrase() hands a phrase's text to the same
 * callbacks speech-to-text calls, so no audio or STT call is made. actions.stopMic turns it off.
 */
export function startTestMic(): { phrase: (text: string) => void } {
  stopMic = () => undefined;
  set({ mic: { on: true, level: 0, error: null } });
  return {
    phrase: (text) => {
      phraseCallbacks.onSpeechEnd();
      phraseCallbacks.onLine(text);
      phraseCallbacks.onSettled();
    },
  };
}

type MicOptions = {
  transcribe: (audio: Uint8Array<ArrayBuffer>) => Promise<TranscribeResult>;
  onFrame?: (frame: Float32Array, sampleRate: number) => void;
};

/** toggleMic's mic on: the mic alone, never system audio. onFrame sees each frame just before the segmenter does. */
async function startMic({ transcribe, onFrame }: MicOptions): Promise<void> {
  try {
    const capture = await openMic();
    const mic = startMicSession({
      sampleRate: capture.sampleRate,
      transcribe,
      ...phraseCallbacks,
      onError: (error) => {
        debugLog.warn("audio", "mic-error", { error });
        setMic({ error });
      },
    });
    const levels = levelSummary();
    capture.start((frame) => {
      onFrame?.(frame, capture.sampleRate);
      const level = mic.push(frame);
      setMic({ level: Math.min(1, level * 4) });
      hintFrame(level, frame);
      levels(level, frame);
    });
    debugLog.info("audio", "mic-on", { sampleRate: capture.sampleRate });
    stopMic = () => {
      capture.stop();
      // The phrase in progress is still transcribed.
      void mic.stop();
    };
    set({ mic: { on: true, level: 0, error: null } });
    // Off the critical path: Teams audio (if the fallback applies) never blocks the mic.
    void syncTeamsAudio();
  } catch (error) {
    debugLog.error("audio", "mic-failed", { error: errorData(error) });
    setMic({ ...MIC_OFF, error: `Microphone unavailable: ${error instanceof Error ? error.message : String(error)}` });
  }
}

// One mic level line every few seconds for the debug log: enough to see silence or clipping, never the audio itself.
const LEVEL_SUMMARY_MS = 5000;
function levelSummary(): (level: number, frame: Float32Array) => void {
  let since = Date.now();
  let frames = 0;
  let sum = 0;
  let max = 0;
  let peak = 0;
  return (level, frame) => {
    if (!debugLog.wants("debug")) return;
    frames += 1;
    sum += level;
    max = Math.max(max, level);
    peak = Math.max(peak, framePeak(frame));
    const now = Date.now();
    if (now - since < LEVEL_SUMMARY_MS) return;
    debugLog.debug("audio", "levels", { frames, avg: Math.round((sum / frames) * 10_000) / 10_000, max: Math.round(max * 10_000) / 10_000, peak: Math.round(peak * 10_000) / 10_000, ms: now - since });
    since = now;
    frames = 0;
    sum = 0;
    max = 0;
    peak = 0;
  };
}

/**
 * E2E only (test/e2e/mic-latency-page.ts): the real mic, segmenter and phrase callbacks. The page wraps transcribe and sees
 * each frame, so it can time every STT call against the audio clock. actions.stopMic turns it off.
 */
export function startTestMicCapture(args: { transcribe: MicOptions["transcribe"]; onFrame: NonNullable<MicOptions["onFrame"]> }): Promise<void> {
  return startMic(args);
}

/** E2E only: pipeline runs started since load, superseded ones included. */
export function runsStarted(): number {
  return latestRun;
}

export const actions = {
  async refreshSettings(): Promise<void> {
    set({ settings: await window.bee.getSettings() });
  },

  /** Resolves true when saved. */
  async saveSettings(update: SettingsUpdate): Promise<boolean> {
    try {
      set({ settings: await window.bee.saveSettings(update), error: null });
      // Switching the Teams audio fallback off stops it at once.
      void syncTeamsAudio();
      return true;
    } catch (error) {
      debugLog.warn("settings", "save-failed", { keys: Object.keys(update), error: errorData(error) });
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
      debugLog.info("mcp", "test", { id, ok: result.ok, tools: result.tools?.length ?? 0, error: result.error ?? null });
      setMcpTest(id, { busy: false, result });
      await actions.refreshMcp();
    } catch (error) {
      setMcpTest(id, { busy: false, result: { ok: false, error: error instanceof Error ? error.message : "Test failed" } });
    }
  },

  /** Close the island body without closing the window. A mic hint closes with it, and its cooldown starts (hints.ts). */
  dismissIsland(): Promise<void> {
    debugLog.info("ui", "dismiss", { confirm: state.computer?.confirm?.id ?? null, hint: state.hint?.id ?? null });
    closeConversation("dismissed");
    // Closing a Confirm prompt is Cancel.
    if (state.computer?.confirm) return actions.answerConfirm(false);
    if (!state.hint) return closeIsland();
    hintDetector.dismiss(state.hint.id);
    // The hint alone holds the body open: close just the hint, so a run in flight keeps its turn.
    if (!responseOpen(state)) return hideHint();
    void hideHint();
    return closeIsland();
  },

  /** Hide one chip for this turn. The island closes when nothing else is left to show. */
  dismissChip(id: string): void {
    if (state.dismissedChipIds.includes(id)) return;
    debugLog.info("ui", "chip-dismissed", { id });
    set({ dismissedChipIds: [...state.dismissedChipIds, id] });
    touchIsland();
    void applyWindowSize();
  },

  /** Open a chip's link in the default browser. Only called from a click; main validates the URL. */
  async openLink(url: string): Promise<void> {
    debugLog.info("ui", "link-opened", { url });
    try {
      await window.bee.openExternalUrl(url);
    } catch {
      // The chip stays; the user can click again.
    }
  },

  /** The one-line answer in the pill was clicked: show it in full in the island itself (never the panel) until the user closes it. */
  openFullText(): void {
    if (!answerFolded(state) || state.expanded) return;
    debugLog.info("ui", "full-text");
    clearTimeout(islandTimer);
    set({ fullText: true, dismissed: false, islandClosing: false });
    void applyWindowSize();
  },

  /** The user clicked outside the island (the window's clear area, or another app took focus): an answer open in full folds back. */
  clickedOutside(): void {
    debugLog.debug("ui", "clicked-outside", { fullText: state.fullText });
    if (state.fullText) void closeIsland();
  },

  /** Scrolling the body is reading it: restart the clock. */
  islandScrolled(): void {
    // At most one log line a second: a scroll fires on every frame.
    const now = Date.now();
    if (now - scrollLoggedAt >= 1000) {
      scrollLoggedAt = now;
      debugLog.debug("ui", "scroll", { hovered: islandHovered });
    }
    if (!islandHovered) touchIsland();
  },

  /** The pointer on the island holds the body open; leaving restarts the clock. */
  setIslandHover(hovered: boolean): void {
    if (hovered !== islandHovered) debugLog.debug("ui", "hover", { hovered });
    islandHovered = hovered;
    touchIsland();
  },

  async setExpanded(expanded: boolean): Promise<void> {
    if (expanded) {
      clearTimeout(islandTimer);
      set({ collapsing: false, expanded: true, fullText: false });
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

  /** Show a tab, opening the panel if it is closed (a tip's full text, the sync status). */
  async openTab(tab: Tab): Promise<void> {
    set({ tab });
    if (!state.expanded || state.collapsing) await actions.setExpanded(true);
  },

  nextSampleLine(): string {
    const line = SAMPLE_LINES[sampleIndex % SAMPLE_LINES.length] ?? "";
    sampleIndex += 1;
    return line;
  },

  /**
   * Add a meeting line (typed, or a phrase from Grok STT) and, if it has content words, schedule retrieve → Jev → Luna (after a
   * short debounce). Mic phrases are also shared with the Teams sync, if one is on and sharing is not paused. A mic phrase that
   * starts with the wake word ("Bee, open Teams") is a direct request instead (takeWakeLine); typed lines never are.
   */
  simulateLine(line: string, source: "typed" | "mic" = "typed"): void {
    const text = line.trim();
    if (!text) return;
    if (source === "typed") debugLog.info("meeting", "typed-line", { text });
    if (source === "mic" && takeWakeLine(text)) return;
    addOwnLine(text, source);
  },

  /**
   * New live caption lines from the call window (experimental meeting window reader). They join the session like teammates'
   * lines ("Alice: …") and follow the same steering rules. They are never shared with the Teams sync. With the mic on, a caption
   * that repeats the user's own recent line is dropped: the mic already sent it.
   */
  captionLines(lines: MeetingWindowCaptions["lines"]): void {
    if (!state.settings?.readMeetingWindowEnabled) return;
    const now = Date.now();
    const own = state.mic.on ? state.session.lines.filter((line) => line.own && now - line.clientTs < CAPTION_ECHO_MS).map((line) => line.text) : [];
    const fresh = lines
      .map((line) => ({ speaker: line.speaker?.trim() || CAPTION_SPEAKER, text: line.text.trim() }))
      .filter((line) => line.text.length > 0 && !echoesOwnLine(line.text, own))
      .map((line): SessionLine => {
        captionSeq += 1;
        return { id: `caption-${captionSeq}`, own: false, speakerId: `caption:${line.speaker}`, speakerName: line.speaker, text: line.text, clientTs: now, serverTs: null };
      });
    debugLog.debug("meeting", "captions", { lines: lines.length, fresh: fresh.map((line) => `${line.speakerName}: ${line.text}`) });
    if (fresh.length > 0 && addLines(fresh)) scheduleRun();
  },

  /**
   * Phrases heard from the Teams app (Teams audio fallback). They join the session as "Meeting: …" and follow the same steering
   * rules as captions. They are never shared with the Teams sync. A phrase that repeats a line Bee already has from the last
   * 20 s (the user's own, a teammate's from their Bee, a caption) is dropped. Console lines carry counts only.
   */
  teamsAudioLines(texts: string[]): void {
    if (!state.settings?.teamsAudioFallbackEnabled) return;
    const now = Date.now();
    const fresh = texts
      .map((text) => text.trim())
      .filter((text) => text.length > 0 && !teamsAudioEcho(text, state.session.lines, now))
      .map((text): SessionLine => {
        teamsAudioSeq += 1;
        return { id: `teams-audio-${teamsAudioSeq}`, own: false, speakerId: TEAMS_AUDIO_SPEAKER_ID, speakerName: TEAMS_AUDIO_SPEAKER, text, clientTs: now, serverTs: null };
      });
    console.debug(`teams-audio lines +${fresh.length} echo ${texts.length - fresh.length}`);
    if (fresh.length > 0 && addLines(fresh)) scheduleRun();
  },

  /** The island's Stop button: ends the direct request in flight (computer use or an answer). */
  stopCommand(): Promise<void> {
    return stopCommand();
  },

  /**
   * The island's Confirm or Cancel for the prompt on screen. This is the only way a Confirm is answered: nothing spoken, typed,
   * captioned or heard from Teams reaches it.
   */
  async answerConfirm(confirmed: boolean): Promise<void> {
    const computer = state.computer;
    const confirm = computer?.confirm;
    if (!computer || !confirm) return;
    debugLog.info("computer", "confirm-tap", { runId: computer.runId, id: confirm.id, kind: confirm.kind, confirmed });
    set({ computer: { ...computer, step: confirmed ? computer.step : "Stopping…", confirm: null } });
    void applyWindowSize();
    try {
      await window.bee.computer.answer({ runId: computer.runId, id: confirm.id, confirmed });
    } catch {
      // Main stops waiting by itself; the run ends with its own line.
    }
  },

  /** Settings: may computer use run here, and what macOS allows it. Unknown on failure. */
  async refreshComputerAccess(): Promise<void> {
    try {
      set({ computerAccess: await window.bee.computer.access() });
    } catch {
      set({ computerAccess: { supported: false, platform: "other", accessibility: "unknown", screenRecording: "unknown" } });
    }
  },

  /** macOS: opens System Settings at Privacy & Security → Accessibility, so the user can allow Bee to read the meeting window. */
  async openAccessibilitySettings(): Promise<void> {
    try {
      await window.bee.meetingWindow.openAccessibilitySettings();
    } catch {
      // The Settings line already says where to go.
    }
  },

  /** macOS: asks for Screen Recording for the Teams audio helper, then lets the next tick try Teams audio again. */
  async openScreenRecordingSettings(): Promise<void> {
    try {
      await window.bee.teamsAudio.openScreenRecordingSettings();
    } catch {
      // The Settings line already says where to go.
    }
    if (state.teamsAudio.failure === "denied") setTeamsAudio({ failed: false, failure: null });
  },

  /**
   * Stop the mic and write the session's summary to the notes folder. The session starts empty for the next
   * meeting straight away; on failure it is put back, ahead of any lines that arrived meanwhile.
   */
  async endMeeting(options: { auto?: boolean } = {}): Promise<void> {
    const ended = state.session;
    // Bee's history and the conversation window end with the meeting, even one with no lines to save.
    closeConversation("meeting-end");
    clearHistory("meeting-end");
    if (ended.lines.length === 0 || state.summary.saving) return;
    debugLog.info("meeting", "end", { auto: options.auto ?? false, lines: ended.lines.length, tips: ended.tips.length, meetingId: sessionMeetingId });
    // An automatic save leaves the mic alone: the next meeting may be starting. It is not retried if it fails.
    if (stopMic && !options.auto) actions.stopMic(null);
    const meetingId = sessionMeetingId;
    sessionMeetingId = null;
    clearTimeout(runTimer);
    runTimer = undefined;
    deferred = false;
    turnOpen = false;
    lastAnswer = [];
    // Lines waiting for a direct request's reply are in the session being saved.
    parkedLines = [];
    set({ keptTips: [], revising: false, session: EMPTY_SESSION, chips: [], dismissedChipIds: [], summary: { saving: true, result: null, error: null } });
    try {
      const result = await window.bee.writeMeetingSummary({
        transcript: summaryTranscript(ended.lines, selfName()),
        notesCited: ended.notesCited,
        tips: ended.tips.map(clampTip),
        ...(meetingId !== null ? { meetingId } : {}),
        sessionToken: await sessionToken(),
      });
      setSummary({ saving: false, result });
    } catch (error) {
      if (!options.auto) sessionMeetingId ??= meetingId;
      const now = state.session;
      set({
        session: {
          lines: mergeLines(ended.lines, now.lines, SESSION_TRANSCRIPT_MAX),
          notesCited: mergeUnique(ended.notesCited, now.notesCited, SESSION_LIST_MAX),
          tips: mergeUnique(ended.tips, now.tips, SESSION_LIST_MAX),
        },
      });
      debugLog.warn("meeting", "summary-failed", { auto: options.auto ?? false, error: errorData(error) });
      setSummary({ saving: false, error: error instanceof Error ? error.message : "Could not save the summary" });
    }
  },

  /** Deletes every saved meeting from local memory. Resolves how many there were. */
  async clearMeetingMemory(): Promise<number> {
    const { cleared } = await window.bee.meeting.clearMemory(await sessionToken());
    // The card recalls a saved meeting: it goes with them.
    if (state.meetingCard) set({ meetingCard: null });
    return cleared;
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
    await startMic({ transcribe: transcribePhrase });
  },

  stopMic(error: string | null): void {
    const stop = stopMic;
    if (stop) debugLog.info("audio", "mic-off", { error });
    stopMic = null;
    stop?.();
    set({ mic: { ...MIC_OFF, error } });
    // Teams audio only runs while the mic is on.
    void syncTeamsAudio();
    // Hints are about the mic: they go with it, and the levels heard are forgotten.
    hintDetector.clear();
    void hideHint();
  },

  async checkForUpdate(): Promise<void> {
    setUpdate({ status: "checking", error: null });
    const check = await window.bee.checkForUpdate();
    if (check.error) setUpdate({ status: "idle", error: check.error });
    else setUpdate({ status: "idle", check, error: null });
  },

  async downloadUpdate(): Promise<void> {
    await downloadUpdate(window.bee, setUpdate);
  },

  async installUpdate(): Promise<void> {
    await installUpdate(window.bee, setUpdate);
  },

  /** The notch button: download if needed, then quit and install (update.ts). */
  async updateNow(): Promise<void> {
    await updateNow(state.update.status, window.bee, setUpdate);
  },

  /** Teams mode: team, popup and sync actions. Resolves true on success; errors show in the UI. */
  async teams(action: TeamsActionInput): Promise<boolean> {
    set({ teamsBusy: true, teamsError: null });
    try {
      const result = await window.bee.teams.act({ ...action, sessionToken: await sessionToken() });
      // The action type only: names and invite codes stay out of the log.
      debugLog.info("teams", "action", { type: action.type, error: result.error, room: result.view.room?.id ?? null });
      set({ teamsBusy: false, teamsError: result.error, inviteOpen: action.type === "startSync" ? !result.error : state.inviteOpen });
      setTeams(result.view);
      return result.error === null;
    } catch (error) {
      debugLog.warn("teams", "action-failed", { type: action.type, error: errorData(error) });
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
setInterval(() => {
  void meetingTick();
  void teamsAudioTick();
}, MEETING_TICK_MS);
// Live captions from the experimental meeting window reader. Test stubs of window.bee may leave it out.
window.bee.meetingWindow?.onCaptions(({ lines }) => actions.captionLines(lines));
