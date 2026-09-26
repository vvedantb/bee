import { z } from "zod";

// One place for every channel name and payload shape crossing the IPC boundary.
export const IPC = {
  getSettings: "bee:settings:get",
  saveSettings: "bee:settings:save",
  runPipeline: "bee:pipeline:run",
  setExpanded: "bee:window:set-expanded",
  openNotesFolder: "bee:notes:open-folder",
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
