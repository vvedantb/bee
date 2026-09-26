import { ipcMain, shell } from "electron";
import { z } from "zod";
import { LUNA_MODEL, NO_GATEWAY_KEY, STT_MODEL, createBeeGateway } from "../core/gateway";
import { runPipeline } from "../core/pipeline";
import { buildLocalSummary, generateMeetingSummary } from "../core/summary";
import { transcribeSpeech } from "../core/transcribe";
import {
  IPC,
  meetingSummaryRequestSchema,
  pipelineRequestSchema,
  transcribeRequestSchema,
  type MeetingSummaryResult,
} from "../shared/ipc";
import { assertSignedIn } from "./auth";
import { isNotePath, loadSnippets, writeMeetingSummaryFile } from "./notes";

/**
 * Mic phrases → Grok STT, lines → retrieve → Jev → Luna, and the end-of-meeting summary into the notes folder.
 * The Gateway key never leaves main.
 */
export function registerMeetingIpc(args: { notesDir: string; gatewayApiKey: () => string | undefined }): void {
  ipcMain.handle(IPC.transcribe, (_event, payload) => {
    const request = transcribeRequestSchema.parse(payload);
    assertSignedIn(request.sessionToken);
    const apiKey = args.gatewayApiKey();
    if (!apiKey) return { text: null, error: NO_GATEWAY_KEY };
    return transcribeSpeech({ model: createBeeGateway(apiKey).transcription(STT_MODEL), audio: request.audio });
  });

  ipcMain.handle(IPC.runPipeline, (_event, payload) => {
    const request = pipelineRequestSchema.parse(payload);
    assertSignedIn(request.sessionToken);
    const apiKey = args.gatewayApiKey();
    return runPipeline({
      transcript: request.transcript,
      snippets: loadSnippets(args.notesDir),
      gateway: apiKey ? createBeeGateway(apiKey) : null,
    });
  });

  // Without a key (or if Luna fails) a plain summary is still written, so the meeting is never lost.
  ipcMain.handle(IPC.writeMeetingSummary, async (_event, payload): Promise<MeetingSummaryResult> => {
    const { sessionToken, ...input } = meetingSummaryRequestSchema.parse(payload);
    assertSignedIn(sessionToken);
    const when = new Date();
    const apiKey = args.gatewayApiKey();
    const summary = apiKey
      ? await generateMeetingSummary({ ...input, model: createBeeGateway(apiKey)(LUNA_MODEL), when })
      : { markdown: buildLocalSummary({ ...input, when }), usedLlm: false, error: NO_GATEWAY_KEY };
    const path = writeMeetingSummaryFile(args.notesDir, summary.markdown, when);
    return { path, usedLlm: summary.usedLlm, error: summary.error };
  });

  ipcMain.handle(IPC.openMeetingSummary, (_event, payload) => {
    const path = z.string().max(4000).parse(payload);
    if (!isNotePath(args.notesDir, path)) throw new Error("Not a note in the notes folder");
    return shell.openPath(path);
  });
}
