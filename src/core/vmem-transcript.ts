import { isVmemConnector } from "../shared/mcp-names";
import type { McpConnection, McpServerConfig } from "./mcp";

// Sends a finished session's transcript to the user's vmem connector through its MCP tool transcript_submit. vmem queues it
// (status "pending"); Dream Mode distills it later, so nothing is saved as memory until then. This is Bee's own call, not one of
// Luna's tools: transcript_submit stays off VMEM_TOOL_ALLOWLIST (core/mcp.ts). Secrets stay in main, where this runs.

export const TRANSCRIPT_TOOL = "transcript_submit";
// Connecting may be cold (the pool closes idle connections); the upload itself can be large.
export const TRANSCRIPT_CONNECT_TIMEOUT_MS = 15_000;
export const TRANSCRIPT_CALL_TIMEOUT_MS = 60_000;
// The reply is a short JSON receipt: id, status, source, byteLength, createdAt.
const RECEIPT_MAX_CHARS = 4000;

/** A saved or live server record, as far as vmem detection needs it. */
export type VmemCandidate = {
  enabled?: boolean;
  serverInfoName?: string;
  /** Listed tools. A tool with enabled false was switched off by the user in Connectors. */
  tools?: ReadonlyArray<{ name: string; enabled?: boolean }>;
  /** Tools switched off (McpServerConfig form). */
  disabledTools?: readonly string[];
};

/**
 * True when Bee may send transcripts here: the connector is on, reports itself as vmem (serverInfo.name, never the URL or the
 * display name), lists transcript_submit, and the user has not switched that tool off.
 */
export function canSubmitTranscripts(server: VmemCandidate): boolean {
  if (server.enabled === false || !isVmemConnector(server)) return false;
  const tool = server.tools?.find((item) => item.name === TRANSCRIPT_TOOL);
  return Boolean(tool) && tool?.enabled !== false && !server.disabledTools?.includes(TRANSCRIPT_TOOL);
}

/** Signed in, or needs no sign-in: a bearer or header server, a stdio one, or OAuth tokens stored. */
export const vmemSignedIn = (config: McpServerConfig): boolean =>
  config.transport === "stdio" || config.auth.type !== "none" || Boolean(config.oauthSignedIn);

/**
 * sent: vmem took it. retry: worth trying later (offline, signed out, a timeout, an error reply). drop: never send it (no vmem,
 * no transcript_submit, or vmem refused it as too large).
 */
export type SubmitOutcome = { status: "sent"; receipt: string } | { status: "retry" | "drop"; reason: string };

export type TranscriptPayload = { title: string; transcript: string };

/** vmem's arguments: transcript and title. profileId is left out, so the active profile is used. */
export function transcriptArguments(payload: TranscriptPayload): Record<string, unknown> {
  return payload.title ? { transcript: payload.transcript, title: payload.title } : { transcript: payload.transcript };
}

// resultText (core/mcp.ts) starts an isError reply with "Error: ".
const ERROR_REPLY = /^Error:/;
const TOO_LARGE = /too large|exceeds|1\.5 ?MB|payload/i;

/**
 * One submit over an injected connection getter (the shared MCP pool in main). Never throws: every failure is an outcome.
 * `drop` is called after a transport failure, so the next try reconnects.
 */
export async function submitTranscript(
  deps: { config: () => McpServerConfig | undefined; connect: (config: McpServerConfig) => Promise<McpConnection>; drop?: (config: McpServerConfig) => void },
  payload: TranscriptPayload,
): Promise<SubmitOutcome> {
  const config = deps.config();
  if (!config || !isVmemConnector(config)) return { status: "drop", reason: "no vmem connector" };
  if (!vmemSignedIn(config)) return { status: "retry", reason: "vmem is not signed in" };
  let connection: McpConnection;
  try {
    connection = await deps.connect(config);
  } catch (error) {
    return { status: "retry", reason: `connect failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  // The live tool list decides: a saved list may be older than the server.
  if (!canSubmitTranscripts({ serverInfoName: config.serverInfoName, tools: connection.tools, disabledTools: config.disabledTools })) {
    return { status: "drop", reason: `vmem has no ${TRANSCRIPT_TOOL} tool` };
  }
  let reply: string;
  try {
    reply = await connection.call(TRANSCRIPT_TOOL, transcriptArguments(payload), TRANSCRIPT_CALL_TIMEOUT_MS, RECEIPT_MAX_CHARS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A slow call leaves the connection fine; any other failure may mean it dropped.
    if (!/timed out/.test(message)) deps.drop?.(config);
    return { status: "retry", reason: `call failed: ${message}` };
  }
  if (ERROR_REPLY.test(reply)) {
    const reason = reply.slice(0, 300);
    return { status: TOO_LARGE.test(reply) ? "drop" : "retry", reason };
  }
  return { status: "sent", receipt: reply.slice(0, 300) };
}
