import { z } from "zod";

// The Bee MCP server's contract, shared by the cloud (convex/beeMcp*.ts) and the desktop loop (core/remote-loop.ts). Another AI
// calls a tool on /mcp; the cloud stores a job; the user's running Bee picks it up over /bee/jobs/next, runs it on this
// computer and posts the result to /bee/jobs/result. Message text crosses here; it is never logged on either side.

export const TEAMS_SEND_TOOL = "teams_send_message";
export const TEAMS_READ_TOOL = "teams_read_chat";
export const BEE_MCP_TOOLS = [TEAMS_SEND_TOOL, TEAMS_READ_TOOL] as const;
export type BeeMcpTool = (typeof BEE_MCP_TOOLS)[number];

export const TEAMS_TO_MAX = 120;
export const TEAMS_TEXT_MAX = 2000;
// A result is one short line, or a read chat (about 20 messages of at most CHAT_MESSAGE_MAX each).
export const JOB_RESULT_MAX = 10_000;
export const CLIENT_NAME_MAX = 40;
export const JOB_ID_MAX = 100;

// Bee polls at least every BEE_LONG_POLL_MS; presence older than BEE_PRESENCE_STALE_MS means Bee is not running.
export const BEE_LONG_POLL_MS = 25_000;
export const BEE_PRESENCE_STALE_MS = 45_000;
// How long a tool call waits for Bee. A send waits on the user's Confirm, which itself times out after 60 s.
export const JOB_WAIT_MS = 120_000;
export const JOB_POLL_MS = 500;

const to = z.string().trim().min(1).max(TEAMS_TO_MAX).describe('The person or group chat name as Teams shows it, or "me" for your own chat.');
export const teamsSendInputSchema = z.object({
  to,
  text: z.string().trim().min(1).max(TEAMS_TEXT_MAX).describe("The exact message."),
  send: z.boolean().describe("true: send it after the user confirms. false: leave it in the box as a draft."),
});
export const teamsReadInputSchema = z.object({ to });
export type TeamsSendInput = z.infer<typeof teamsSendInputSchema>;
export type TeamsReadInput = z.infer<typeof teamsReadInputSchema>;

const jobId = z.string().min(1).max(JOB_ID_MAX);
const clientName = z.string().max(CLIENT_NAME_MAX).nullable();
export const remoteJobSchema = z.discriminatedUnion("tool", [
  z.object({ id: jobId, tool: z.literal(TEAMS_SEND_TOOL), input: teamsSendInputSchema, clientName }),
  z.object({ id: jobId, tool: z.literal(TEAMS_READ_TOOL), input: teamsReadInputSchema, clientName }),
]);
export type RemoteJob = z.infer<typeof remoteJobSchema>;

/** POST /bee/jobs/next: the oldest pending job (now running), or null after the long poll. */
// Loose here: a job this Bee cannot read still has an id, so Bee can say so instead of leaving the AI waiting.
export const nextJobResponseSchema = z.object({ job: z.looseObject({ id: jobId }).nullable() });
/** POST /bee/jobs/result: the outcome of one of the caller's own jobs. ok false is an error for the AI that asked. */
export const jobResultSchema = z.object({ id: jobId, ok: z.boolean(), text: z.string().max(JOB_RESULT_MAX) });
export type JobResult = z.infer<typeof jobResultSchema>;

/** The tool's input for its tool name, or null when the stored input does not fit (a newer cloud, a bad row). */
export function parseJob(raw: { id: string; tool: string; input: string; clientName: string | null }): RemoteJob | null {
  try {
    const parsed = remoteJobSchema.safeParse({ id: raw.id, tool: raw.tool, input: JSON.parse(raw.input), clientName: raw.clientName });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** "Request from Claude…": the first step line on Bee's island for a job from another AI. */
export function remoteRequestLine(clientName: string | null): string {
  return `Request from ${clientName?.trim() || "another AI"}…`;
}
