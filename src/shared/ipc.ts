import { z } from "zod";

// One place for every channel name and payload shape crossing the IPC boundary.
export const IPC = {
  getSettings: "bee:settings:get",
  saveSettings: "bee:settings:save",
  runPipeline: "bee:pipeline:run",
  transcribe: "bee:speech:transcribe",
  writeMeetingSummary: "bee:meeting:write-summary",
  openMeetingSummary: "bee:meeting:open-summary",
  setExpanded: "bee:window:set-expanded",
  openNotesFolder: "bee:notes:open-folder",
  checkForUpdate: "bee:update:check",
  downloadUpdate: "bee:update:download",
  installUpdate: "bee:update:install",
};

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

export const meetingSummaryRequestSchema = z.object({
  transcript: z.array(z.string().max(2000)).min(1).max(SESSION_TRANSCRIPT_MAX),
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
