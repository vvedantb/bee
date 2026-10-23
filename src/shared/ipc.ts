import { z } from "zod";
import { INTERFACE_SCALES } from "../core/interface-scale";
import { MOTION_PREFERENCES } from "../core/motion-preference";

// One place for every channel name and payload shape crossing the IPC boundary.
export const IPC = {
  getSettings: "bee:settings:get",
  saveSettings: "bee:settings:save",
  revealGatewayKey: "bee:settings:reveal-gateway-key",
  copyGatewayKey: "bee:settings:copy-gateway-key",
  runPipeline: "bee:pipeline:run",
  transcribe: "bee:speech:transcribe",
  writeMeetingSummary: "bee:meeting:write-summary",
  openMeetingSummary: "bee:meeting:open-summary",
  setWindowSize: "bee:window:set-size",
  openNotesFolder: "bee:notes:open-folder",
  checkForUpdate: "bee:update:check",
  downloadUpdate: "bee:update:download",
  installUpdate: "bee:update:install",
  teamsTick: "bee:teams:tick",
  teamsAction: "bee:teams:action",
  teamsPublish: "bee:teams:publish",
  lunaActivity: "bee:luna:activity",
  lunaPartial: "bee:luna:partial",
  cancelPipeline: "bee:pipeline:cancel",
  systemAudioSource: "bee:audio:system-source",
  mcpList: "bee:mcp:list",
  mcpSave: "bee:mcp:save",
  mcpRemove: "bee:mcp:remove",
  mcpSetEnabled: "bee:mcp:set-enabled",
  mcpTest: "bee:mcp:test",
  mcpAuthorize: "bee:mcp:authorize",
  openExternalUrl: "bee:shell:open-url",
  enrichLinks: "bee:links:enrich",
  getFavicon: "bee:favicon:get",
  meetingContext: "bee:meeting:context",
  clearMeetingMemory: "bee:meeting:clear-memory",
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
  meetingMode: z.boolean(),
  // Zoom factor for the whole overlay, always an allowed value.
  interfaceScale: interfaceScaleSchema,
  motionPreference: motionPreferenceSchema,
  secretStorage: secretStorageSchema,
  notesDir: z.string(),
  fsRoots: z.array(z.string()),
  // Meeting context (core/meeting-context.ts). All on by default. Calendar and memory only matter while the master switch is on.
  meetingContextEnabled: z.boolean(),
  meetingCalendarEnabled: z.boolean(),
  meetingMemoryEnabled: z.boolean(),
});
export type SettingsView = z.infer<typeof settingsViewSchema>;

// Secrets: omitted = unchanged, "" = clear.
export const settingsUpdateSchema = z.object({
  gatewayApiKey: z.string().max(500).optional(),
  meetingMode: z.boolean().optional(),
  interfaceScale: interfaceScaleSchema.optional(),
  motionPreference: motionPreferenceSchema.optional(),
  personalisedLinks: z.boolean().optional(),
  // Extra absolute folders Luna may read; replaces the saved list.
  fsRoots: z.array(z.string().max(1000)).max(20).optional(),
  meetingContextEnabled: z.boolean().optional(),
  meetingCalendarEnabled: z.boolean().optional(),
  meetingMemoryEnabled: z.boolean().optional(),
});
export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;

// On request only, to Bee's own window: the saved Gateway key (never the env key), or null when none is saved.
export const revealGatewayKeyResultSchema = z.string().max(500).nullable();
// Copy writes the saved key to the clipboard in main; the reply only says whether there was one.
export const copyGatewayKeyResultSchema = z.object({ copied: z.boolean() });
export type CopyGatewayKeyResult = z.infer<typeof copyGatewayKeyResultSchema>;

// Names one pipeline run, so the renderer can cancel it when a newer line supersedes it.
const runIdSchema = z.union([z.string().max(100), z.number()]);

export const pipelineRequestSchema = z.object({
  transcript: z.array(z.string().max(2000)).min(1).max(50),
  runId: runIdSchema.optional(),
  // Tips already on screen when a newer line restarts the run (live steering). Complete lines only.
  shown: z.array(z.string().max(500)).max(3).optional(),
  // Clerk session token; main refuses to run the pipeline without a live one (main/auth.ts).
  sessionToken: z.string().max(8000),
});
export type PipelineRequest = z.infer<typeof pipelineRequestSchema>;

export const pipelineCancelSchema = z.object({ runId: runIdSchema });
export type PipelineCancel = z.infer<typeof pipelineCancelSchema>;

// Lines the renderer keeps for the end-of-meeting summary (store.ts); the pipeline still gets only the last 8.
export const SESSION_TRANSCRIPT_MAX = 200;

// A plain line (solo), or a speaker-labelled one once teammates are synced.
export const transcriptLineSchema = z.union([z.string().max(2000), z.object({ speaker: z.string().max(100), text: z.string().max(2000) })]);

export const meetingSummaryRequestSchema = z.object({
  transcript: z.array(transcriptLineSchema).min(1).max(SESSION_TRANSCRIPT_MAX),
  // Titles of notes cited in tips during the meeting.
  notesCited: z.array(z.string().max(500)).max(100),
  tips: z.array(z.string().max(500)).max(100),
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
});
export type MeetingContextView = z.infer<typeof meetingContextViewSchema>;

export const clearMeetingMemoryResultSchema = z.object({ cleared: z.number().int().nonnegative() });

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
  tips: z.array(z.string()),
  sources: z.array(z.object({ title: z.string().max(300), url: z.string().url().max(2000) })).max(5),
  guideError: z.string().nullable(),
  /** Muted note when connected tools were skipped. */
  guideNote: z.string().max(300).nullable().optional(),
  /** Enabled MCP servers Luna could not use this turn, with a short reason (never a secret). */
  mcpErrors: z.array(z.object({ server: z.string().max(200), error: z.string().max(300) })).max(20).optional(),
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
export const lunaPartialSchema = z.object({ runId: runIdSchema.optional(), tips: z.array(z.string().max(500)).max(5) });
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
