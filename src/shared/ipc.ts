import { z } from "zod";

// One place for every channel name and payload shape crossing the IPC boundary.
export const IPC = {
  getSettings: "bee:settings:get",
  saveSettings: "bee:settings:save",
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
};

// Collapsed notch, notch plus the sync popup, or the full panel.
export const windowSizeSchema = z.enum(["collapsed", "prompt", "expanded"]);
export type WindowSize = z.infer<typeof windowSizeSchema>;

export const secretStorageSchema = z.enum(["os", "weak", "memory"]);

export const settingsViewSchema = z.object({
  gatewayKeySource: z.enum(["saved", "env", "none"]),
  hasClaudeToken: z.boolean(),
  meetingMode: z.boolean(),
  secretStorage: secretStorageSchema,
  notesDir: z.string(),
});
export type SettingsView = z.infer<typeof settingsViewSchema>;

// Secrets: omitted = unchanged, "" = clear.
export const settingsUpdateSchema = z.object({
  gatewayApiKey: z.string().max(500).optional(),
  claudeOAuthToken: z.string().max(4000).optional(),
  meetingMode: z.boolean().optional(),
});
export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;

export const pipelineRequestSchema = z.object({
  transcript: z.array(z.string().max(2000)).min(1).max(50),
  // Clerk session token; main refuses to run the pipeline without a live one (main/auth.ts).
  sessionToken: z.string().max(8000),
});
export type PipelineRequest = z.infer<typeof pipelineRequestSchema>;

// Lines the renderer keeps for the end-of-meeting summary (store.ts); the pipeline still gets only the last 8.
export const SESSION_TRANSCRIPT_MAX = 200;

// A plain line (solo), or a speaker-labelled one once teammates are synced.
export const transcriptLineSchema = z.union([z.string().max(2000), z.object({ speaker: z.string().max(100), text: z.string().max(2000) })]);

export const meetingSummaryRequestSchema = z.object({
  transcript: z.array(transcriptLineSchema).min(1).max(SESSION_TRANSCRIPT_MAX),
  // Titles of notes cited in tips during the meeting.
  notesCited: z.array(z.string().max(500)).max(100),
  tips: z.array(z.string().max(500)).max(100),
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
  guideError: z.string().nullable(),
  timingsMs: z.object({ retrieve: z.number(), rank: z.number(), guide: z.number() }),
});
export type PipelineResult = z.infer<typeof pipelineResultSchema>;

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
