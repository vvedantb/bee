import { ipcMain } from "electron";
import { NO_GATEWAY_KEY, STT_MODEL, createBeeGateway } from "../core/gateway";
import { runPipeline } from "../core/pipeline";
import { transcribeSpeech } from "../core/transcribe";
import { IPC, pipelineRequestSchema, transcribeRequestSchema } from "../shared/ipc";
import { assertSignedIn } from "./auth";
import { loadSnippets } from "./notes";

/** Mic phrases → Grok STT, and lines → retrieve → Jev → Luna. The Gateway key never leaves main. */
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
}
