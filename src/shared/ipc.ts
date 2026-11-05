import { z } from "zod";
import { DEBUG_LEVELS } from "../core/debug-log";
import { INTERFACE_SCALES } from "../core/interface-scale";
import { MOTION_PREFERENCES } from "../core/motion-preference";
import { TEAMS_AUDIO_FAILURES } from "../core/teams-audio-protocol";
import { MCP_ICON_MAX_CHARS } from "./mcp-icons";

// One place for every channel name and payload shape crossing the IPC boundary.
export const IPC = {
  getSettings: "bee:settings:get",
  saveSettings: "bee:settings:save",
  revealGatewayKey: "bee:settings:reveal-gateway-key",
  copyGatewayKey: "bee:settings:copy-gateway-key",
  runPipeline: "bee:pipeline:run",
  runCommand: "bee:command:run",
  transcribe: "bee:speech:transcribe",
  writeMeetingSummary: "bee:meeting:write-summary",
  openMeetingSummary: "bee:meeting:open-summary",
  setWindowSize: "bee:window:set-size",
  openNotesFolder: "bee:notes:open-folder",
  openLogsFolder: "bee:logs:open-folder",
  debugLog: "bee:debug:log",
  checkForUpdate: "bee:update:check",
  downloadUpdate: "bee:update:download",
  installUpdate: "bee:update:install",
  teamsTick: "bee:teams:tick",
  teamsAction: "bee:teams:action",
  teamsPublish: "bee:teams:publish",
  lunaActivity: "bee:luna:activity",
  lunaPartial: "bee:luna:partial",
  cancelPipeline: "bee:pipeline:cancel",
  mcpList: "bee:mcp:list",
  mcpSave: "bee:mcp:save",
  mcpRemove: "bee:mcp:remove",
  mcpSignOut: "bee:mcp:sign-out",
  mcpSetEnabled: "bee:mcp:set-enabled",
  mcpTest: "bee:mcp:test",
  mcpAuthorize: "bee:mcp:authorize",
  openExternalUrl: "bee:shell:open-url",
  enrichLinks: "bee:links:enrich",
  getFavicon: "bee:favicon:get",
  /** One https image URL in, a data URL (or null) out. Used for connector icons (serverInfo.icons / Icon URL). */
  getHttpsIcon: "bee:icon:get",
  meetingContext: "bee:meeting:context",
  clearMeetingMemory: "bee:meeting:clear-memory",
  /** Settings → Saved memory: Bee's memory facts for direct requests (main/bee-memory-store.ts), listed and cleared. */
  memoryList: "bee:memory:list",
  memoryClear: "bee:memory:clear",
  meetingWindowCaptions: "bee:meeting-window:captions",
  openAccessibilitySettings: "bee:meeting-window:open-accessibility-settings",
  teamsAudioStatus: "bee:teams-audio:status",
  teamsAudioStart: "bee:teams-audio:start",
  teamsAudioStop: "bee:teams-audio:stop",
  teamsAudioLines: "bee:teams-audio:lines",
  teamsAudioEnded: "bee:teams-audio:ended",
  openScreenRecordingSettings: "bee:teams-audio:open-screen-recording-settings",
  stopCommand: "bee:command:stop",
  computerUpdate: "bee:computer:update",
  computerAnswer: "bee:computer:answer",
  computerAccess: "bee:computer:access",
  classifyFollowUp: "bee:command:classify-follow-up",
  conversationEnded: "bee:command:conversation-ended",
};

// Collapsed notch, notch plus the sync popup, notch plus the island response, or the full panel.
export const windowSizeSchema = z.enum(["collapsed", "prompt", "response", "expanded"]);
export type WindowSize = z.infer<typeof windowSizeSchema>;

// The allowed Interface size factors (core/interface-scale.ts); a save with any other number is rejected.
const interfaceScaleSchema = z.number().refine((value) => (INTERFACE_SCALES as readonly number[]).includes(value), { message: "Unsupported interface size" });

// The allowed Animations values (core/motion-preference.ts).
const motionPreferenceSchema = z.enum(MOTION_PREFERENCES);

export const secretStorageSchema = z.enum(["os", "weak", "memory"]);

export const settingsViewSchema = z.object({
  gatewayKeySource: z.enum(["saved", "env", "none"]),
  // Personalised link suggestions: the effective toggle, and whether an enabled vmem connector (Connectors tab) exists.
  personalisedLinks: z.boolean(),
  vmemConnected: z.boolean(),
  // Send finished meetings and conversations to vmem's transcript_submit (main/vmem-transcript-queue.ts). Effective value: on
  // while an enabled vmem connector exists, until the user sets it.
  sendSessionsToVmem: z.boolean(),
  meetingMode: z.boolean(),
  // Zoom factor for the whole overlay, always an allowed value.
  interfaceScale: interfaceScaleSchema,
  motionPreference: motionPreferenceSchema,
  secretStorage: secretStorageSchema,
  notesDir: z.string(),
  // The local debug log folder (main/debug-log.ts), beside the notes folder. Logs stay on this computer and are never deleted.
  logsDir: z.string(),
  fsRoots: z.array(z.string()),
  // Names Bee should know (core/known-names.ts): typed here or learned from spelling corrections and chat names on screen.
  knownNames: z.array(z.string()),
  // Meeting context (core/meeting-context.ts). All on by default. Calendar and memory only matter while the master switch is on.
  meetingContextEnabled: z.boolean(),
  meetingCalendarEnabled: z.boolean(),
  meetingMemoryEnabled: z.boolean(),
  // Experimental: read the meeting window (Teams, Zoom, Google Meet) with agent-desktop. Off by default.
  readMeetingWindowEnabled: z.boolean(),
  // Teams audio fallback: with the mic on in a Teams call where someone may not have Bee, hear the Teams app alone (never all
  // system audio). Off by default; only platforms with a Teams-only capture path listen (core/teams-audio.ts).
  teamsAudioFallbackEnabled: z.boolean(),
  // Mic hints (renderer/src/hints.ts): local suggestions when the mic is silent, quiet or too loud. On by default.
  hintsEnabled: z.boolean(),
  // "Bee" wake word (core/wake-word.ts): an own mic phrase that starts with "Bee…" is a direct request to the AI, not meeting
  // conversation. On by default.
  wakeWordEnabled: z.boolean(),
  // "Ask before sending or deleting" (core/computer-gate.ts): computer use waits for a Confirm tap in the island before it
  // sends, deletes, buys or submits a form. Ordinary clicks do not ask. On by default.
  askBeforeSendingEnabled: z.boolean(),
  // Verbose debug logs (main/debug-log.ts): every event of a session, prompts and replies included, on this computer only. Off
  // keeps warnings and errors. On by default for now.
  verboseLogging: z.boolean(),
});
export type SettingsView = z.infer<typeof settingsViewSchema>;

// Secrets: omitted = unchanged, "" = clear.
export const settingsUpdateSchema = z.object({
  gatewayApiKey: z.string().max(500).optional(),
  meetingMode: z.boolean().optional(),
  interfaceScale: interfaceScaleSchema.optional(),
  motionPreference: motionPreferenceSchema.optional(),
  personalisedLinks: z.boolean().optional(),
  sendSessionsToVmem: z.boolean().optional(),
  // Extra absolute folders Luna may read; replaces the saved list.
  fsRoots: z.array(z.string().max(1000)).max(20).optional(),
  // Names Bee should know; replaces the saved list (core/known-names.ts KNOWN_NAMES_MAX, NAME_MAX_CHARS).
  knownNames: z.array(z.string().max(200)).max(400).optional(),
  meetingContextEnabled: z.boolean().optional(),
  meetingCalendarEnabled: z.boolean().optional(),
  meetingMemoryEnabled: z.boolean().optional(),
  readMeetingWindowEnabled: z.boolean().optional(),
  teamsAudioFallbackEnabled: z.boolean().optional(),
  hintsEnabled: z.boolean().optional(),
  wakeWordEnabled: z.boolean().optional(),
  askBeforeSendingEnabled: z.boolean().optional(),
  verboseLogging: z.boolean().optional(),
});
export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;

// Renderer → main: a batch of debug log events (renderer/src/debug-log.ts), fire and forget. Main redacts each one and writes it
// to the local log (main/debug-log.ts); nothing is uploaded. Names are short codes; data is any JSON, capped in size by main.
export const DEBUG_BATCH_MAX = 200;
export const debugLogEventSchema = z.object({
  // When it happened in the renderer, ms since the epoch.
  ts: z.number().finite(),
  level: z.enum(DEBUG_LEVELS),
  category: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  event: z.string().regex(/^[a-z][a-z0-9._-]{0,79}$/i),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type DebugLogEvent = z.infer<typeof debugLogEventSchema>;
// Each event is checked on its own (debugLogEventSchema), so one bad event does not drop the rest of its batch.
export const debugLogBatchSchema = z.object({ events: z.array(z.unknown()).min(1).max(DEBUG_BATCH_MAX) });
export type DebugLogBatch = { events: DebugLogEvent[] };

// On request only, to Bee's own window: the saved Gateway key (never the env key), or null when none is saved.
export const revealGatewayKeyResultSchema = z.string().max(500).nullable();
// Copy writes the saved key to the clipboard in main; the reply only says whether there was one.
export const copyGatewayKeyResultSchema = z.object({ copied: z.boolean() });
export type CopyGatewayKeyResult = z.infer<typeof copyGatewayKeyResultSchema>;

// Names one pipeline run, so the renderer can cancel it when a newer line supersedes it.
const runIdSchema = z.union([z.string().max(100), z.number()]);

// One tip line. Full-text answers run to several hundred characters, and Luna's 800 output tokens fit well under this cap.
// Tips are clamped to it where they are parsed (core/luna.ts) and before the renderer sends them back, so a real tip never fails IPC.
export const TIP_MAX_CHARS = 4000;
export const clampTip = (tip: string): string => tip.slice(0, TIP_MAX_CHARS);
const tipSchema = z.string().max(TIP_MAX_CHARS);
// A tip's publishers, such as "TfL" or "TfL, Evening Standard" (up to three), cut to this where it is parsed (core/luna.ts). Null for a tip with no web source.
export const TIP_SOURCE_MAX_CHARS = 80;
// Each tip's source, by position. Optional: a result without it shows no labels.
const tipSourcesSchema = z.array(z.string().max(TIP_SOURCE_MAX_CHARS).nullable()).max(10).optional();

export const pipelineRequestSchema = z.object({
  transcript: z.array(z.string().max(2000)).min(1).max(50),
  runId: runIdSchema.optional(),
  // Tips already on screen when a newer line restarts the run (live steering). Complete lines only.
  shown: z.array(tipSchema).max(3).optional(),
  // On a new turn: the latest settled tips, gone from the screen but sent as context so a follow-up question can use them.
  earlier: z.array(tipSchema).max(3).optional(),
  // How many of the newest transcript lines belong to the current turn (the request to answer). The rest are background.
  turnLines: z.number().int().min(1).max(50).optional(),
  // The last answer (earlier or shown) came from a web search, so a follow-up keeps the search tool (core/web-search.ts).
  searched: z.boolean().optional(),
  // Clerk session token; main refuses to run the pipeline without a live one (main/auth.ts).
  sessionToken: z.string().max(8000),
});
export type PipelineRequest = z.infer<typeof pipelineRequestSchema>;

// A direct request to the AI: an own mic phrase that started with the wake word, without it ("open Teams"), or a follow-up in
// the conversation window after one. It is never a meeting line: not in the session, the summary, meeting memory or the Teams
// sync. The reply comes back as a PipelineResult.
export const COMMAND_MAX_CHARS = 2000;
// One exchange with Bee (core/bee-history.ts BeeExchange), for vmem's conversation transcript only: the AI gets Bee's whole
// history from main (main/bee-history-store.ts), never from the renderer. A conversation sends at most this many at once; the
// store sends a longer one in parts.
export const CONVERSATION_EXCHANGES_MAX = 50;
export const beeExchangeSchema = z.object({
  request: z.string().max(COMMAND_MAX_CHARS),
  reply: z.string().max(COMMAND_MAX_CHARS),
  actions: z.array(z.string().max(300)).max(6).optional(),
  endedWhere: z.string().max(300).optional(),
  error: z.string().max(300).optional(),
  at: z.number(),
});
export const commandRequestSchema = z.object({
  command: z.string().trim().min(1).max(COMMAND_MAX_CHARS),
  // The latest meeting lines, as background for a request about the meeting ("what did Priya just say"). Never answered as tips.
  transcript: z.array(z.string().max(2000)).max(8).optional(),
  runId: runIdSchema.optional(),
  sessionToken: z.string().max(8000),
});
export type CommandRequest = z.infer<typeof commandRequestSchema>;

// Renderer → main, fire and forget: a conversation of direct requests ended (no exchange with Bee for CONVERSATION_IDLE_MS, or
// CONVERSATION_EXCHANGES_MAX reached). Main sends it to vmem when "Send finished sessions to vmem" is on
// (main/vmem-transcript-queue.ts). Bee's own history is not cleared by it. Never sent when a meeting ends (the meeting is sent instead).
export const conversationEndedSchema = z.object({
  exchanges: z.array(beeExchangeSchema).min(1).max(CONVERSATION_EXCHANGES_MAX),
  sessionToken: z.string().max(8000),
});
export type ConversationEnded = z.infer<typeof conversationEndedSchema>;

// While the conversation window is open, an own mic phrase that is neither clearly for Bee nor clearly for the meeting: one small
// AI call decides (core/follow-up.ts). Lines are labelled "me:" or "them:".
export const followUpRequestSchema = z.object({
  phrase: z.string().trim().min(1).max(1000),
  lastBee: z.object({ request: z.string().max(COMMAND_MAX_CHARS), reply: z.string().max(COMMAND_MAX_CHARS) }),
  lines: z.array(z.string().max(1000)).max(3),
  // No one else heard for a minute (core/follow-up.ts OTHERS_QUIET_MS): the prompt leans toward Bee.
  othersQuiet: z.boolean(),
  sessionToken: z.string().max(8000),
});
export type FollowUpRequest = z.infer<typeof followUpRequestSchema>;
export const followUpResultSchema = z.object({ addressed: z.enum(["bee", "meeting"]), confidence: z.number().min(0).max(1) }).nullable();
export type FollowUpResult = z.infer<typeof followUpResultSchema>;

export const pipelineCancelSchema = z.object({ runId: runIdSchema });
export type PipelineCancel = z.infer<typeof pipelineCancelSchema>;

// Stop: the island's Stop button or "Bee, stop" (own mic only). Main stops that request's computer use (or its answer), and
// the request still returns, with "Stopped." as its line.
export const commandStopSchema = z.object({ runId: runIdSchema });
export type CommandStop = z.infer<typeof commandStopSchema>;

// Main → renderer while computer use runs (core/computer-use.ts): the step in progress as one short line ("Clicking Send…"),
// or a Confirm prompt before a send, delete, purchase or form (core/computer-gate.ts). Lines describe the user's own screen
// to the user; they never go to the console (the local debug log keeps them, main/debug-log.ts).
export const COMPUTER_LINE_MAX = 120;
export const computerUpdateSchema = z.discriminatedUnion("type", [
  z.object({ runId: runIdSchema, type: z.literal("step"), label: z.string().max(COMPUTER_LINE_MAX) }),
  z.object({
    runId: runIdSchema,
    type: z.literal("confirm"),
    id: z.number().int().positive(),
    kind: z.enum(["send", "delete", "buy", "submit"]),
    question: z.string().max(COMPUTER_LINE_MAX),
    detail: z.string().max(COMPUTER_LINE_MAX),
  }),
]);
export type ComputerUpdate = z.infer<typeof computerUpdateSchema>;

// Renderer → main: the user's tap on a Confirm prompt. Only the island's Confirm and Cancel buttons send it; nothing spoken,
// typed, captioned or heard from Teams can.
export const computerAnswerSchema = z.object({ runId: runIdSchema, id: z.number().int().positive(), confirmed: z.boolean() });
export type ComputerAnswer = z.infer<typeof computerAnswerSchema>;

// What computer use may do here, for Settings. supported: Windows, Mac or Linux with agent-desktop. States are agent-desktop's:
// on Linux, accessibility denied means no AT-SPI bus in this session (no D-Bus session, or not a desktop session).
const accessStateSchema = z.enum(["granted", "denied", "not_required", "unknown"]);
export const computerAccessSchema = z.object({
  supported: z.boolean(),
  platform: z.enum(["mac", "windows", "linux", "other"]),
  accessibility: accessStateSchema,
  screenRecording: accessStateSchema,
});
export type ComputerAccessView = z.infer<typeof computerAccessSchema>;

// Lines the renderer keeps for the end-of-meeting summary (store.ts); the pipeline still gets only the last 8.
export const SESSION_TRANSCRIPT_MAX = 200;

// A plain line (solo), or a speaker-labelled one once teammates are synced.
export const transcriptLineSchema = z.union([z.string().max(2000), z.object({ speaker: z.string().max(100), text: z.string().max(2000) })]);

export const meetingSummaryRequestSchema = z.object({
  transcript: z.array(transcriptLineSchema).min(1).max(SESSION_TRANSCRIPT_MAX),
  // Titles of notes cited in tips during the meeting.
  notesCited: z.array(z.string().max(500)).max(100),
  tips: z.array(tipSchema).max(100),
  // The detected meeting (MeetingContextView.id) the lines belong to, so a summary written after the next meeting began still
  // saves to the right meeting memory.
  meetingId: z.number().int().nonnegative().optional(),
  sessionToken: z.string().max(8000),
});
export type MeetingSummaryRequest = z.infer<typeof meetingSummaryRequestSchema>;

// The file is always written. usedLlm is false when Luna was skipped (no key) or failed; error says why.
export const meetingSummaryResultSchema = z.object({
  path: z.string(),
  usedLlm: z.boolean(),
  error: z.string().nullable(),
});
export type MeetingSummaryResult = z.infer<typeof meetingSummaryResultSchema>;

// Experimental meeting window reader (main/meeting-window-reader.ts). Names and words never appear here.
// off: the setting is off. starting: first checks. ready: reading (app: the call found, if any). needs-permission: macOS
// Accessibility is not granted. unavailable: agent-desktop is missing or cannot run here; the built-in detector carries on.
export const meetingWindowStatusSchema = z.object({
  state: z.enum(["off", "starting", "ready", "needs-permission", "unavailable"]),
  app: z.enum(["teams", "zoom", "meet"]).nullable(),
  // Live captions are visible in the call window and feed the pipeline.
  captions: z.boolean(),
});
export type MeetingWindowStatus = z.infer<typeof meetingWindowStatusSchema>;

// The meeting Bee detected from window titles and the local Outlook calendar (core/meeting-context.ts). Main keeps the brief
// that goes to Luna; the renderer only sees the name and up to two island lines.
export const meetingContextRequestSchema = z.object({ sessionToken: z.string().max(8000) });
export const meetingContextViewSchema = z.object({
  enabled: z.boolean(),
  // True while the debounced detection says the user is in a call.
  active: z.boolean(),
  // Increments with each new meeting. Kept after the call ends, so the renderer can finish saving it. 0: none yet.
  id: z.number().int().nonnegative(),
  subject: z.string().max(200).nullable(),
  source: z.enum(["calendar", "title", "none"]),
  // "Last time with these people…" for the island at meeting start. Empty without an earlier meeting.
  card: z.array(z.string().max(200)).max(2),
  // The experimental meeting window reader, for its Settings status line. Absent when main has no reader.
  reader: meetingWindowStatusSchema.optional(),
});
export type MeetingContextView = z.infer<typeof meetingContextViewSchema>;

// Main → renderer: new live caption lines from the call window. The renderer adds them like teammates' lines. Never in
// console output; the local debug log keeps them.
export const meetingWindowCaptionsSchema = z.object({
  lines: z.array(z.object({ speaker: z.string().max(100).nullable(), text: z.string().min(1).max(2000) })).min(1).max(50),
});
export type MeetingWindowCaptions = z.infer<typeof meetingWindowCaptionsSchema>;

// Teams audio fallback (core/teams-audio.ts, main/teams-audio.ts). Codes only: never names, titles, audio or words. The
// renderer decides when to listen (store.ts teamsAudioPlan); main runs the helper, speech-to-text and sends back lines.
export const teamsAudioStatusRequestSchema = z.object({ sessionToken: z.string().max(8000) });
export const teamsAudioStatusSchema = z.object({
  platform: z.enum(["windows", "mac", "linux", "other"]),
  // This build can capture the Teams app's audio alone here. Bee never captures all system audio instead.
  supported: z.boolean(),
  // Why not: unsupported-platform (Linux and others), needs-app-audio (no Teams-only path in this build), os-too-old (below
  // the helper's floor: Windows 10 2004, macOS 13), helper-missing (the native helper is not installed).
  reason: z.enum(["unsupported-platform", "needs-app-audio", "os-too-old", "helper-missing"]).nullable(),
  // A Teams call now: the built-in Windows detector, the meeting window reader on a Teams call, or a simulated Teams meeting.
  teamsCall: z.boolean(),
  // covered: everyone in the call has Bee in this sync, so Bee does not listen. uncovered or unknown: Bee listens.
  coverage: z.enum(["covered", "uncovered", "unknown"]),
  // macOS Screen Recording for the helper, as the last capture found it. not-needed on Windows and elsewhere. unknown until
  // the first capture; denied stays until a capture starts or the user asks for access again.
  permission: z.enum(["not-needed", "unknown", "granted", "denied"]),
});
export type TeamsAudioStatus = z.infer<typeof teamsAudioStatusSchema>;

export const teamsAudioFailureSchema = z.enum(TEAMS_AUDIO_FAILURES);
// Start: main checks the plan again, starts the helper and waits for it to report ready. id names this capture, so lines and
// the end of an older capture are ignored.
export const teamsAudioStartRequestSchema = z.object({ sessionToken: z.string().max(8000) });
export const teamsAudioStartResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), id: z.number().int().positive() }),
  z.object({ ok: z.literal(false), failure: teamsAudioFailureSchema }),
]);
export type TeamsAudioStartResult = z.infer<typeof teamsAudioStartResultSchema>;
// Main → renderer: phrases heard in the Teams app, as text. The renderer adds them as "Meeting" lines. Never shared or
// in console output; the local debug log keeps them.
export const TEAMS_AUDIO_LINE_MAX = 2000;
export const teamsAudioLinesSchema = z.object({
  id: z.number().int().positive(),
  lines: z.array(z.string().min(1).max(TEAMS_AUDIO_LINE_MAX)).min(1).max(10),
});
export type TeamsAudioLines = z.infer<typeof teamsAudioLinesSchema>;
// Main → renderer: a capture stopped by itself. failure null: main stopped it (the call ended, everyone has Bee, the renderer
// went quiet); otherwise why it failed.
export const teamsAudioEndedSchema = z.object({ id: z.number().int().positive(), failure: teamsAudioFailureSchema.nullable() });
export type TeamsAudioEnded = z.infer<typeof teamsAudioEndedSchema>;

export const clearMeetingMemoryResultSchema = z.object({ cleared: z.number().int().nonnegative() });

// Settings → Saved memory: Bee's own memory facts (core/bee-memory.ts), not saved meetings. Both channels need a session.
// The fact shape is repeated here so the preload never loads core/bee-memory.ts (and the AI SDK with it); ipc.test.ts keeps the
// two in step. Oldest first, as main keeps them.
export const MEMORY_FACT_KINDS = ["person", "preference", "app", "other"] as const;
export const memoryRequestSchema = z.object({ sessionToken: z.string().max(8000) });
export const memoryFactViewSchema = z.object({ text: z.string().min(1).max(200), kind: z.enum(MEMORY_FACT_KINDS), updated: z.string().max(10) });
export type MemoryFactView = z.infer<typeof memoryFactViewSchema>;
export const memoryListResultSchema = z.object({ facts: z.array(memoryFactViewSchema).max(200) });
export const memoryClearResultSchema = z.object({ cleared: z.number().int().nonnegative() });

// 15 s of 16 kHz 16-bit mono WAV is about 480 KB; the cap leaves room without letting a runaway buffer through.
export const TRANSCRIBE_MAX_BYTES = 2_000_000;

export const transcribeRequestSchema = z.object({
  // One spoken phrase as WAV bytes (renderer/src/speech.ts encodeWav).
  audio: z.instanceof(Uint8Array).refine((audio) => audio.byteLength > 44 && audio.byteLength <= TRANSCRIBE_MAX_BYTES, {
    message: "Audio must be a non-empty WAV under 2 MB",
  }),
  sessionToken: z.string().max(8000),
});
export type TranscribeRequest = z.infer<typeof transcribeRequestSchema>;

// text is null when the phrase had no words. The text never reaches the UI: the renderer feeds it to the pipeline.
export const transcribeResultSchema = z.object({ text: z.string().nullable(), error: z.string().nullable() });
export type TranscribeResult = z.infer<typeof transcribeResultSchema>;

export const rankedNoteSchema = z.object({
  id: z.string(),
  title: z.string(),
  text: z.string(),
  retrieveScore: z.number(),
  jevScore: z.number().nullable(),
  // Citation label (e.g. "n1") when the note was sent to Luna; tips cite notes by this label.
  cite: z.string().nullable(),
});
export type RankedNote = z.infer<typeof rankedNoteSchema>;

export const pipelineResultSchema = z.object({
  notes: z.array(rankedNoteSchema),
  rankSource: z.enum(["jev", "fallback"]),
  rankError: z.string().nullable(),
  tips: z.array(tipSchema),
  tipSources: tipSourcesSchema,
  sources: z.array(z.object({ title: z.string().max(300), url: z.string().url().max(2000) })).max(5),
  guideError: z.string().nullable(),
  /** Muted note when connected tools were skipped. */
  guideNote: z.string().max(300).nullable().optional(),
  /** Enabled MCP servers Luna could not use this turn, with a short reason (never a secret). */
  mcpErrors: z.array(z.object({ server: z.string().max(200), error: z.string().max(300) })).max(20).optional(),
  /** A direct request only: its desktop action lines ("Opened Vercel"), and where computer use left the screen. For Bee's history. */
  actions: z.array(z.string().max(300)).max(10).optional(),
  endedWhere: z.string().max(300).optional(),
  // Numbers only, in ms. rank: Jev (runs beside Luna). mcp: MCP connect and list (runs beside Jev). guide: Luna alone, without the MCP wait.
  // lunaFirstToken is null when no text streamed. loadNotes is added in main.
  timingsMs: z.object({
    retrieve: z.number(),
    rank: z.number(),
    guide: z.number(),
    mcp: z.number(),
    lunaFirstToken: z.number().nullable(),
    lunaTotal: z.number(),
    loadNotes: z.number().optional(),
  }),
});
export type PipelineResult = z.infer<typeof pipelineResultSchema>;

// Main → renderer while Luna runs: a tool call starting or ending, for the run that asked (renderer/src/island.ts: activityLabel).
export const lunaActivitySchema = z.object({ runId: runIdSchema.optional(), tool: z.string().max(80), phase: z.enum(["start", "end"]) });
export type LunaActivity = z.infer<typeof lunaActivitySchema>;

// Main → renderer while Luna streams: the tips so far (finished lines, plus a line with a few words). Never the transcript.
export const lunaPartialSchema = z.object({ runId: runIdSchema.optional(), tips: z.array(tipSchema).max(5), tipSources: tipSourcesSchema });
export type LunaPartial = z.infer<typeof lunaPartialSchema>;

export const updateCheckSchema = z.object({
  currentVersion: z.string(),
  // Null when no release is published (or the check failed).
  latestVersion: z.string().nullable(),
  // Newer than the running app and has an installer for this platform.
  available: z.boolean(),
  releaseUrl: z.string().nullable(),
  error: z.string().nullable(),
});
export type UpdateCheck = z.infer<typeof updateCheckSchema>;

// Download and install report failures as values, so offline states read cleanly in the UI.
export const updateActionSchema = z.object({ error: z.string().nullable() });
export type UpdateAction = z.infer<typeof updateActionSchema>;

// Teams mode (main/teams-sync.ts, core/sync-controller.ts). Bee never joins the call: it only watches for desktop
// Teams being in a meeting, and syncs mute-gated phrases with teammates who accepted, through the Bee relay.

const memberViewSchema = z.object({ userId: z.string(), displayName: z.string() });

export const roomOptionSchema = z.object({
  roomId: z.string(),
  code: z.string(),
  names: z.array(z.string()),
  label: z.string(),
  reason: z.enum(["invited", "recent", "other"]),
  createdAt: z.number(),
  ageMinutes: z.number(),
  invitedBy: z.string().nullable(),
});

// A desktop meeting window, named by its title only (Bee has no Microsoft meeting id). key: normalised label.
export const meetingCandidateSchema = z.object({ key: z.string(), title: z.string(), label: z.string() });

export const teamsViewSchema = z.object({
  // False when BEE_RELAY_URL is not set: Teams mode is off and Bee works solo.
  relayConfigured: z.boolean(),
  // Set while the relay cannot be reached. Bee keeps working solo (fail open).
  relayError: z.string().nullable(),
  // Short-lived message, e.g. "The sync ended".
  notice: z.string().nullable(),
  me: memberViewSchema.nullable(),
  team: z
    .object({ id: z.string(), name: z.string(), inviteCode: z.string(), inviteLink: z.string(), members: z.array(memberViewSchema) })
    .nullable(),
  // From a bee://team/… link, waiting for the user to confirm.
  pendingInvite: z.string().nullable(),
  detection: z.object({
    inMeeting: z.boolean(),
    raw: z.boolean(),
    epoch: z.number(),
    source: z.enum(["windows", "simulated", "none"]),
  }),
  // The "Join Alice, Bob / Start new" popup for the current detection. With two or more meeting windows and none
  // picked yet (selectedMeetingKey null), it first asks "Which meeting?" and has no primary. ambiguous: two or more
  // syncs match equally well, so there is no one-click Join.
  prompt: z
    .object({
      epoch: z.number(),
      primary: roomOptionSchema.nullable(),
      others: z.array(roomOptionSchema),
      ambiguous: z.boolean(),
      meetings: z.array(meetingCandidateSchema),
      selectedMeetingKey: z.string().nullable(),
    })
    .nullable(),
  room: z
    .object({
      id: z.string(),
      code: z.string(),
      createdAt: z.number(),
      startedByMe: z.boolean(),
      members: z.array(memberViewSchema),
      invited: z.array(z.string()),
    })
    .nullable(),
  // Teammates in a meeting now and not in my sync, for the optional invite step. Nobody is pre-ticked.
  roster: z.array(memberViewSchema),
  // Another sync started within 30 s of mine: "Merge with Bob's sync?". waiting: I tapped, they have not.
  merge: z.object({ roomId: z.string(), label: z.string(), waiting: z.boolean() }).nullable(),
  shareMuted: z.boolean(),
});
export type TeamsView = z.infer<typeof teamsViewSchema>;

export const sessionLineSchema = z.object({
  id: z.string(),
  own: z.boolean(),
  speakerId: z.string(),
  speakerName: z.string(),
  text: z.string(),
  clientTs: z.number(),
  serverTs: z.number().nullable(),
});

export const teamsTickRequestSchema = z.object({ sessionToken: z.string().max(8000) });
export const teamsTickResultSchema = z.object({ view: teamsViewSchema, lines: z.array(sessionLineSchema) });
export type TeamsTickResult = z.infer<typeof teamsTickResultSchema>;

const token = { sessionToken: z.string().max(8000) };
const name = z.string().trim().min(1).max(80);
export const teamsActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("createTeam"), name, displayName: name, ...token }),
  z.object({ type: z.literal("joinTeam"), code: z.string().trim().min(1).max(200), displayName: name, ...token }),
  z.object({ type: z.literal("leaveTeam"), ...token }),
  z.object({ type: z.literal("copyInvite"), ...token }),
  z.object({ type: z.literal("startSync"), invite: z.array(z.string().max(200)).max(50), ...token }),
  z.object({ type: z.literal("joinSync"), roomId: z.string().max(100), ...token }),
  z.object({ type: z.literal("joinSyncByCode"), code: z.string().trim().min(1).max(100), ...token }),
  z.object({ type: z.literal("leaveSync"), ...token }),
  z.object({ type: z.literal("invite"), userIds: z.array(z.string().max(200)).min(1).max(50), ...token }),
  z.object({ type: z.literal("merge"), accept: z.boolean(), ...token }),
  z.object({ type: z.literal("dismissPrompt"), ...token }),
  // "Which meeting?": the user picks one of the concurrent meeting windows; the sync is bound to it until it ends.
  z.object({ type: z.literal("selectMeeting"), key: z.string().max(300), ...token }),
  z.object({ type: z.literal("setShareMuted"), muted: z.boolean(), ...token }),
  // Manual test: pretend desktop Teams is in a meeting (for Linux, macOS and E2E). meetings: window titles to pretend
  // are open; none means an unnamed call (mic only).
  z.object({
    type: z.literal("simulateMeeting"),
    on: z.boolean(),
    meetings: z.array(z.object({ title: z.string().trim().min(1).max(300) })).max(10).optional(),
    ...token,
  }),
]);
export type TeamsAction = z.infer<typeof teamsActionSchema>;
type WithoutToken<A> = A extends TeamsAction ? Omit<A, "sessionToken"> : never;
// Teams actions as the UI sends them; the store adds the session token.
export type TeamsActionInput = WithoutToken<TeamsAction>;

export const teamsActionResultSchema = z.object({ view: teamsViewSchema, error: z.string().nullable() });
export type TeamsActionResult = z.infer<typeof teamsActionResultSchema>;

export const teamsPublishRequestSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  clientTs: z.number(),
  // Only mic phrases are shared; typed test lines stay local.
  source: z.enum(["mic", "typed"]),
  ...token,
});
export type TeamsPublishRequest = z.infer<typeof teamsPublishRequestSchema>;
export const teamsPublishResultSchema = z.object({ sent: z.boolean(), error: z.string().nullable() });

// MCP servers (core/mcp.ts, main/settings.ts). Secrets (bearer token, header value, env values) stay in main.
export const MCP_MAX_SERVERS = 20;
export const MCP_MAX_TOOLS = 100;

export const mcpToolSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(300),
  enabled: z.boolean(),
});
export type McpTool = z.infer<typeof mcpToolSchema>;

export const mcpAuthSchema = z.object({
  type: z.enum(["none", "bearer", "header"]),
  headerName: z.string().max(100).optional(),
});

// The non-secret record kept in settings.json.
export const mcpServerSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(40),
  enabled: z.boolean(),
  transport: z.enum(["http", "stdio"]),
  url: z.string().max(2000).optional(),
  command: z.string().max(1000).optional(),
  args: z.array(z.string().max(1000)).max(50).optional(),
  // Names only. The values are encrypted separately.
  envKeys: z.array(z.string().max(200)).max(50).optional(),
  auth: mcpAuthSchema,
  tools: z.array(mcpToolSchema).max(MCP_MAX_TOOLS).optional(),
  // What the server reported in MCP initialize (serverInfo), saved on connect, test or sign-in. A bad value reads as unset,
  // so it never drops the server list. serverInfoName identifies vmem (isVmemConnector); iconUrl is the chosen https: or data: icon.
  serverInfoName: z.string().max(200).optional().catch(undefined),
  websiteUrl: z.string().max(2000).optional().catch(undefined),
  iconUrl: z.string().max(MCP_ICON_MAX_CHARS).optional().catch(undefined),
  // The user's Icon URL (https: or data:). Wins over iconUrl.
  iconOverride: z.string().max(2000).optional().catch(undefined),
});
export type McpServer = z.infer<typeof mcpServerSchema>;

// What the renderer sees: hasAuth says a secret (bearer, header or OAuth sign-in) is stored, never what it is.
export const mcpServerViewSchema = mcpServerSchema.extend({ envKeys: z.array(z.string()), hasAuth: z.boolean() });
export type McpServerView = z.infer<typeof mcpServerViewSchema>;
export const mcpListSchema = z.array(mcpServerViewSchema);

// Secrets: omitted = unchanged, "" = clear. args and env are text: one per line (args may also be space-separated).
export const mcpSaveSchema = z.object({
  id: z.string().max(64).optional(),
  name: z.string().trim().min(1).max(40),
  enabled: z.boolean(),
  transport: z.enum(["http", "stdio"]),
  url: z.string().trim().max(2000).optional(),
  command: z.string().trim().max(1000).optional(),
  args: z.string().max(4000).optional(),
  env: z.string().max(8000).optional(),
  auth: mcpAuthSchema,
  // Bearer token, or the value of the custom header.
  secret: z.string().max(4000).optional(),
  // Icon URL override, https: or data:. Omitted = unchanged, "" = clear.
  iconOverride: z.string().trim().max(2000).optional(),
});
export type McpSave = z.infer<typeof mcpSaveSchema>;

export const mcpIdSchema = z.object({ id: z.string().min(1).max(64) });
export const mcpSetEnabledSchema = z.object({
  id: z.string().min(1).max(64),
  // Without tool, the whole server is switched.
  tool: z.string().min(1).max(200).optional(),
  enabled: z.boolean(),
});
export type McpSetEnabled = z.infer<typeof mcpSetEnabledSchema>;

export const mcpTestResultSchema = z.object({
  ok: z.boolean(),
  tools: z.array(mcpToolSchema).max(MCP_MAX_TOOLS).optional(),
  error: z.string().max(400).optional(),
});
export type McpTestResult = z.infer<typeof mcpTestResultSchema>;

// Link chips: the renderer asks main to open one http(s) URL in the default browser. Main validates it again.
export const openExternalUrlSchema = z.string().max(2000);
export const openExternalUrlResultSchema = z.object({ ok: z.boolean() });
export type OpenExternalUrlResult = z.infer<typeof openExternalUrlResultSchema>;

// A link chip as it crosses IPC (core/link-suggest.ts LinkChip).
export const linkChipSchema = z.object({
  id: z.string().max(253),
  domain: z.string().max(253),
  url: z.string().max(2000),
  label: z.string().max(300),
});

// Personalised links: this turn's text and the detector's chips go to main, which asks vmem and Jev (only with the toggle on).
// The reply keeps the chips' order and leaves out the ones Jev rejected. Any failure returns the chips unchanged.
export const enrichLinksRequestSchema = z.object({
  turn: z.string().max(4000),
  chips: z.array(linkChipSchema).max(5),
});
export type EnrichLinksRequest = z.infer<typeof enrichLinksRequestSchema>;
export const enrichLinksResultSchema = z.object({ chips: z.array(linkChipSchema).max(5) });

// Favicons: a domain in, a data URL (or null) out. Fetched and cached in main.
export const faviconRequestSchema = z.string().max(253);
export const faviconResultSchema = z.string().max(200_000).nullable();
// Connector https icons: a full https URL in, a data URL (or null) out. Same size cap as favicons.
export const httpsIconRequestSchema = z.string().url().max(2000);
export const httpsIconResultSchema = faviconResultSchema;
