import { app, ipcMain, shell } from "electron";
import { z } from "zod";
import { loadMcpTools, type McpPool, type McpServerConfig } from "../core/mcp";
import type { MeetingContext } from "../core/meeting-context";
import { GUIDE_MODEL, NO_GATEWAY_KEY, STT_MODEL, createBeeGateway } from "../core/gateway";
import { runPipeline } from "../core/pipeline";
import { searchLocation } from "../core/web-search";
import { buildLocalSummary, generateMeetingSummary } from "../core/summary";
import { transcribeSpeech } from "../core/transcribe";
import {
  IPC,
  meetingContextRequestSchema,
  meetingSummaryRequestSchema,
  pipelineCancelSchema,
  pipelineRequestSchema,
  transcribeRequestSchema,
  type LunaActivity,
  type MeetingSummaryResult,
} from "../shared/ipc";
import { assertSignedIn } from "./auth";
import { isNotePath, loadSnippets, writeMeetingSummaryFile } from "./notes";

/**
 * Mic phrases → Grok STT, lines → retrieve → Jev → Luna, and the end-of-meeting summary into the notes folder.
 * The Gateway key never leaves main.
 */
export function registerMeetingIpc(args: { notesDir: string; fsRoots: () => string[];
  mcpConfigs: () => McpServerConfig[];
  /** Enabled sign-in servers with no tokens. mcpConfigs leaves them out; Luna is told they are not signed in. */
  mcpSignedOut: () => string[];
  /** Tool lists and warm connections, shared across runs. */
  mcpPool: McpPool;
  /** Which meeting the user is in, its brief for Luna, and the saved meetings. */
  meeting: MeetingContext;
  gatewayApiKey: () => string | undefined }): void {
  // One controller per run in flight. The renderer cancels a run when a newer line supersedes it.
  const runs = new Map<string, AbortController>();

  ipcMain.handle(IPC.transcribe, (_event, payload) => {
    const request = transcribeRequestSchema.parse(payload);
    assertSignedIn(request.sessionToken);
    const apiKey = args.gatewayApiKey();
    if (!apiKey) return { text: null, error: NO_GATEWAY_KEY };
    return transcribeSpeech({ model: createBeeGateway(apiKey).transcription(STT_MODEL), audio: request.audio });
  });

  // The renderer polls this every few seconds. Main steps detection (title and calendar reads are throttled inside).
  ipcMain.handle(IPC.meetingContext, (_event, payload) => {
    const request = meetingContextRequestSchema.parse(payload);
    assertSignedIn(request.sessionToken);
    return args.meeting.tick();
  });

  ipcMain.handle(IPC.clearMeetingMemory, (_event, payload) => {
    const request = meetingContextRequestSchema.parse(payload);
    assertSignedIn(request.sessionToken);
    return { cleared: args.meeting.clearMemory() };
  });

  ipcMain.handle(IPC.runPipeline, async (event, payload) => {
    const request = pipelineRequestSchema.parse(payload);
    assertSignedIn(request.sessionToken);
    const apiKey = args.gatewayApiKey();
    const key = request.runId === undefined ? null : String(request.runId);
    const controller = new AbortController();
    if (key !== null) {
      runs.get(key)?.abort();
      runs.set(key, controller);
    }
    const loadStarted = performance.now();
    const snippets = loadSnippets(args.notesDir);
    const loadNotes = performance.now() - loadStarted;
    console.debug(`perf load-notes ${Math.round(loadNotes)}ms`);
    try {
      const result = await runPipeline({
        transcript: request.transcript,
        shown: request.shown,
        earlier: request.earlier,
        turnLines: request.turnLines,
        searched: request.searched,
        // Read per run, so a time zone change while travelling applies at once.
        searchLocation: searchLocation({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: app.getSystemLocale() }),
        meetingBrief: args.meeting.brief(),
        snippets,
        gateway: apiKey ? createBeeGateway(apiKey) : null,
        notesDir: args.notesDir,
        extraRoots: args.fsRoots(),
        // Settings are read now, so changes apply without a restart. Tool lists come from the pool's cache; servers connect on first call.
        loadMcpTools: async () => {
          const signedOut = args.mcpSignedOut().map((server) => ({ server, error: "not signed in" }));
          const mcp = await loadMcpTools(args.mcpConfigs(), { pool: args.mcpPool });
          return { ...mcp, errors: [...signedOut, ...mcp.errors] };
        },
        signal: controller.signal,
        onActivity: (activity) => {
          if (!event.sender.isDestroyed()) event.sender.send(IPC.lunaActivity, { runId: request.runId, ...activity } satisfies LunaActivity);
        },
        onPartial: (tips) => {
          if (!controller.signal.aborted && !event.sender.isDestroyed()) event.sender.send(IPC.lunaPartial, { runId: request.runId, tips });
        },
      });
      return { ...result, timingsMs: { ...result.timingsMs, loadNotes } };
    } finally {
      if (key !== null && runs.get(key) === controller) runs.delete(key);
    }
  });

  // Cancels Jev and Luna for a superseded run. A tool call that has started is left to finish (it may be a write).
  ipcMain.handle(IPC.cancelPipeline, (_event, payload) => {
    const { runId } = pipelineCancelSchema.parse(payload);
    runs.get(String(runId))?.abort();
  });

  // Without a key (or if Luna fails) a plain summary is still written, so the meeting is never lost.
  ipcMain.handle(IPC.writeMeetingSummary, async (_event, payload): Promise<MeetingSummaryResult> => {
    const { sessionToken, ...input } = meetingSummaryRequestSchema.parse(payload);
    assertSignedIn(sessionToken);
    const when = new Date();
    const apiKey = args.gatewayApiKey();
    const summary = apiKey
      ? await generateMeetingSummary({ ...input, model: createBeeGateway(apiKey)(GUIDE_MODEL), when })
      : { markdown: buildLocalSummary({ ...input, when }), usedLlm: false, error: NO_GATEWAY_KEY };
    const path = writeMeetingSummaryFile(args.notesDir, summary.markdown, when);
    // Structured fields go to meeting memory too (when it is on and the meeting has a name). Failing to save never loses the note.
    try {
      const remembered = args.meeting.remember({ meetingId: input.meetingId, summaryMarkdown: summary.markdown, usedLlm: summary.usedLlm, tips: input.tips });
      console.debug(`perf meeting-memory saved=${remembered ? 1 : 0}`);
    } catch {
      console.debug("perf meeting-memory saved=0");
    }
    return { path, usedLlm: summary.usedLlm, error: summary.error };
  });

  ipcMain.handle(IPC.openMeetingSummary, (_event, payload) => {
    const path = z.string().max(4000).parse(payload);
    if (!isNotePath(args.notesDir, path)) throw new Error("Not a note in the notes folder");
    return shell.openPath(path);
  });
}
