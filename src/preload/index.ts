import { exposeClerkBridge } from "@clerk/electron/preload";
import { contextBridge, ipcRenderer } from "electron";
import { z } from "zod";
import {
  IPC,
  enrichLinksResultSchema,
  faviconResultSchema,
  httpsIconResultSchema,
  lunaActivitySchema,
  lunaPartialSchema,
  clearMeetingMemoryResultSchema,
  memoryClearResultSchema,
  memoryListResultSchema,
  computerAccessSchema,
  claudeCodeViewSchema,
  claudeCodeUpdateResultSchema,
  computerUpdateSchema,
  copyGatewayKeyResultSchema,
  meetingContextViewSchema,
  meetingWindowCaptionsSchema,
  mcpListSchema,
  mcpTestResultSchema,
  meetingSummaryResultSchema,
  openExternalUrlResultSchema,
  pipelineResultSchema,
  followUpResultSchema,
  revealGatewayKeyResultSchema,
  settingsViewSchema,
  teamsActionResultSchema,
  teamsAudioEndedSchema,
  teamsAudioLinesSchema,
  teamsAudioStartResultSchema,
  teamsAudioStatusSchema,
  teamsPublishResultSchema,
  teamsTickResultSchema,
  transcribeResultSchema,
  updateActionSchema,
  updateCheckSchema,
  type CommandRequest,
  type ConversationEnded,
  type FollowUpRequest,
  type CommandStop,
  type ComputerAnswer,
  type ComputerUpdate,
  type DebugLogBatch,
  type EnrichLinksRequest,
  type LunaActivity,
  type LunaPartial,
  type McpSave,
  type McpSetEnabled,
  type MeetingSummaryRequest,
  type MeetingWindowCaptions,
  type PipelineCancel,
  type PipelineRequest,
  type SettingsUpdate,
  type TeamsAction,
  type TeamsAudioEnded,
  type TeamsAudioLines,
  type TeamsPublishRequest,
  type TranscribeRequest,
  type WindowSize,
} from "../shared/ipc";

// One failure report per method and message a minute; repeats in between are counted into the next one.
const FAILURE_REPEAT_MS = 60_000;
const failures = new Map<string, { at: number; repeats: number }>();

/** Tells the local debug log that a call failed: main threw, or its reply failed the schema. Never the call's arguments. */
function reportFailure(method: string, error: unknown, started: number): void {
  const message = error instanceof Error ? error.message : String(error);
  const key = `${method}\n${message}`;
  const now = Date.now();
  const seen = failures.get(key);
  if (seen && now - seen.at < FAILURE_REPEAT_MS) {
    seen.repeats += 1;
    return;
  }
  // Messages that differ every time (ids, times) must not grow the map for ever.
  if (failures.size >= 200) failures.clear();
  failures.set(key, { at: now, repeats: 0 });
  const data = { method, ms: Math.round(performance.now() - started), name: error instanceof Error ? error.name : typeof error, message, repeats: seen?.repeats ?? 0 };
  try {
    ipcRenderer.send(IPC.debugLog, { events: [{ ts: now, level: "warn", category: "ipc", event: "call-failed", data }] } satisfies DebugLogBatch);
  } catch {
    // Logging never breaks the call it watches.
  }
}

/** Wraps every method so a rejected call is reported (reportFailure) and then rejects as before. */
function withFailureReports<T extends Record<string, unknown>>(target: T, path = ""): T {
  for (const [key, value] of Object.entries(target)) {
    const method = path ? `${path}.${key}` : key;
    if (typeof value === "function") {
      (target as Record<string, unknown>)[key] = (...args: unknown[]) => {
        const started = performance.now();
        const result: unknown = value(...args);
        return result instanceof Promise
          ? result.catch((error: unknown) => {
              reportFailure(method, error, started);
              throw error;
            })
          : result;
      };
    } else if (value && typeof value === "object") {
      withFailureReports(value as Record<string, unknown>, method);
    }
  }
  return target;
}

// The only surface the renderer can reach. Every response is parsed before it crosses the bridge.
const api = {
  getSettings: async () => settingsViewSchema.parse(await ipcRenderer.invoke(IPC.getSettings)),
  saveSettings: async (update: SettingsUpdate) =>
    settingsViewSchema.parse(await ipcRenderer.invoke(IPC.saveSettings, update)),
  // The saved Gateway key (never the env key) after the eye button is pressed; undefined when none is saved.
  revealGatewayKey: async () => revealGatewayKeyResultSchema.parse(await ipcRenderer.invoke(IPC.revealGatewayKey)) ?? undefined,
  // Main copies the saved key to the clipboard; false when none is saved.
  copyGatewayKey: async () => copyGatewayKeyResultSchema.parse(await ipcRenderer.invoke(IPC.copyGatewayKey)).copied,
  runPipeline: async (request: PipelineRequest) =>
    pipelineResultSchema.parse(await ipcRenderer.invoke(IPC.runPipeline, request)),
  // A direct request ("Bee, open Teams"): the reply and any desktop action lines, shaped like a pipeline result. Cancelled like a run.
  runCommand: async (request: CommandRequest) => pipelineResultSchema.parse(await ipcRenderer.invoke(IPC.runCommand, request)),
  // In the conversation window: is an unclear own mic phrase for Bee or the meeting? Null when main cannot tell (no key, failure).
  classifyFollowUp: async (request: FollowUpRequest) => followUpResultSchema.parse(await ipcRenderer.invoke(IPC.classifyFollowUp, request)),
  // Bee's history cleared after idle: main may send that finished conversation to vmem. Fire and forget; main checks the setting.
  conversationEnded: async (request: ConversationEnded) => {
    z.void().parse(await ipcRenderer.invoke(IPC.conversationEnded, request));
  },
  // Cancels a run a newer line has superseded. Fire and forget: the run's own result is dropped anyway.
  cancelPipeline: async (request: PipelineCancel) => {
    z.void().parse(await ipcRenderer.invoke(IPC.cancelPipeline, request));
  },
  // Stops a direct request (the island's Stop, or "Bee, stop" from the user's own mic). Its result still comes back: "Stopped."
  stopCommand: async (request: CommandStop) => {
    z.void().parse(await ipcRenderer.invoke(IPC.stopCommand, request));
  },
  // Computer use: the step in progress and Confirm prompts, the user's Confirm or Cancel tap, and what macOS allows.
  computer: {
    onUpdate: (listener: (update: ComputerUpdate) => void): (() => void) => {
      const handler = (_event: unknown, payload: unknown) => {
        const parsed = computerUpdateSchema.safeParse(payload);
        if (parsed.success) listener(parsed.data);
      };
      ipcRenderer.on(IPC.computerUpdate, handler);
      return () => {
        ipcRenderer.removeListener(IPC.computerUpdate, handler);
      };
    },
    answer: async (answer: ComputerAnswer) => {
      z.void().parse(await ipcRenderer.invoke(IPC.computerAnswer, answer));
    },
    access: async () => computerAccessSchema.parse(await ipcRenderer.invoke(IPC.computerAccess)),
  },
  /** The user's Claude Code for "Bee, …" requests. `fresh` checks again now (Settings → Check again). */
  claudeCode: async (fresh: boolean) => claudeCodeViewSchema.parse(await ipcRenderer.invoke(IPC.claudeCode, fresh)),
  /** Runs `claude update` (Settings → Update Claude Code). */
  updateClaudeCode: async () => claudeCodeUpdateResultSchema.parse(await ipcRenderer.invoke(IPC.claudeCodeUpdate)),
  transcribe: async (request: TranscribeRequest) =>
    transcribeResultSchema.parse(await ipcRenderer.invoke(IPC.transcribe, request)),
  writeMeetingSummary: async (request: MeetingSummaryRequest) =>
    meetingSummaryResultSchema.parse(await ipcRenderer.invoke(IPC.writeMeetingSummary, request)),
  // Resolves to shell.openPath's error message, "" on success.
  openMeetingSummary: async (path: string) => z.string().parse(await ipcRenderer.invoke(IPC.openMeetingSummary, path)),
  // Opens one http(s) link in the default browser after a click. Main re-checks the URL.
  openExternalUrl: async (url: string) => openExternalUrlResultSchema.parse(await ipcRenderer.invoke(IPC.openExternalUrl, url)),
  // Personalised link chips: main asks vmem and Jev. Fails open with the chips unchanged.
  enrichLinks: async (request: EnrichLinksRequest) => enrichLinksResultSchema.parse(await ipcRenderer.invoke(IPC.enrichLinks, request)),
  // A site's icon as a data URL, fetched and cached in main. null when none could be fetched.
  getFavicon: async (domain: string) => faviconResultSchema.parse(await ipcRenderer.invoke(IPC.getFavicon, domain)),
  // A connector https icon URL as a data URL. null when none could be fetched. data: icons are used as-is in the renderer.
  getHttpsIcon: async (url: string) => httpsIconResultSchema.parse(await ipcRenderer.invoke(IPC.getHttpsIcon, url)),
  setWindowSize: async (size: WindowSize) => {
    z.void().parse(await ipcRenderer.invoke(IPC.setWindowSize, size));
  },
  openNotesFolder: async () => {
    z.string().parse(await ipcRenderer.invoke(IPC.openNotesFolder));
  },
  // The local debug log folder, beside the notes folder.
  openLogsFolder: async () => {
    z.string().parse(await ipcRenderer.invoke(IPC.openLogsFolder));
  },
  // Debug log events for main to redact and write on this computer (renderer/src/debug-log.ts). Fire and forget.
  debugLog: (batch: DebugLogBatch) => {
    ipcRenderer.send(IPC.debugLog, batch);
  },
  checkForUpdate: async () => updateCheckSchema.parse(await ipcRenderer.invoke(IPC.checkForUpdate)),
  downloadUpdate: async () => updateActionSchema.parse(await ipcRenderer.invoke(IPC.downloadUpdate)),
  installUpdate: async () => updateActionSchema.parse(await ipcRenderer.invoke(IPC.installUpdate)),
  // Tool calls starting and ending while a run is in flight. Returns the unsubscribe function.
  onLunaActivity: (listener: (activity: LunaActivity) => void): (() => void) => {
    const handler = (_event: unknown, payload: unknown) => {
      const parsed = lunaActivitySchema.safeParse(payload);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on(IPC.lunaActivity, handler);
    return () => {
      ipcRenderer.removeListener(IPC.lunaActivity, handler);
    };
  },
  // Tips so far while Luna streams (finished lines). Returns the unsubscribe function.
  onLunaPartial: (listener: (partial: LunaPartial) => void): (() => void) => {
    const handler = (_event: unknown, payload: unknown) => {
      const parsed = lunaPartialSchema.safeParse(payload);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on(IPC.lunaPartial, handler);
    return () => {
      ipcRenderer.removeListener(IPC.lunaPartial, handler);
    };
  },
  // MCP servers. Views carry hasAuth and env key names only; secrets never come back.
  mcp: {
    list: async () => mcpListSchema.parse(await ipcRenderer.invoke(IPC.mcpList)),
    save: async (server: McpSave) => mcpListSchema.parse(await ipcRenderer.invoke(IPC.mcpSave, server)),
    remove: async (id: string) => mcpListSchema.parse(await ipcRenderer.invoke(IPC.mcpRemove, { id })),
    // Revokes and clears the sign-in tokens and switches the server off; the server stays saved.
    signOut: async (id: string) => mcpListSchema.parse(await ipcRenderer.invoke(IPC.mcpSignOut, { id })),
    setEnabled: async (update: McpSetEnabled) => mcpListSchema.parse(await ipcRenderer.invoke(IPC.mcpSetEnabled, update)),
    test: async (id: string) => mcpTestResultSchema.parse(await ipcRenderer.invoke(IPC.mcpTest, { id })),
    // Opens the system browser for MCP sign-in and resolves once tokens are stored in main.
    authorize: async (id: string) => mcpListSchema.parse(await ipcRenderer.invoke(IPC.mcpAuthorize, { id })),
  },
  // The detected meeting and its island card, and the saved-meetings clear. Main keeps the brief.
  meeting: {
    context: async (sessionToken: string) => meetingContextViewSchema.parse(await ipcRenderer.invoke(IPC.meetingContext, { sessionToken })),
    clearMemory: async (sessionToken: string) => clearMeetingMemoryResultSchema.parse(await ipcRenderer.invoke(IPC.clearMeetingMemory, { sessionToken })),
  },
  // Settings → Saved memory: Bee's memory facts for direct requests, oldest first, and the clear. Never history or saved meetings.
  memory: {
    list: async (sessionToken: string) => memoryListResultSchema.parse(await ipcRenderer.invoke(IPC.memoryList, { sessionToken })),
    clear: async (sessionToken: string) => memoryClearResultSchema.parse(await ipcRenderer.invoke(IPC.memoryClear, { sessionToken })),
  },
  // Experimental meeting window reader: new live caption lines from the call window, and the macOS Accessibility pane.
  meetingWindow: {
    onCaptions: (listener: (captions: MeetingWindowCaptions) => void): (() => void) => {
      const handler = (_event: unknown, payload: unknown) => {
        const parsed = meetingWindowCaptionsSchema.safeParse(payload);
        if (parsed.success) listener(parsed.data);
      };
      ipcRenderer.on(IPC.meetingWindowCaptions, handler);
      return () => {
        ipcRenderer.removeListener(IPC.meetingWindowCaptions, handler);
      };
    },
    openAccessibilitySettings: async () => {
      z.void().parse(await ipcRenderer.invoke(IPC.openAccessibilitySettings));
    },
  },
  // Teams audio fallback: platform support, a Teams call and coverage, as codes. The renderer decides to listen; main runs the
  // helper and speech-to-text, and sends back text lines only (never audio).
  teamsAudio: {
    status: async (sessionToken: string) => teamsAudioStatusSchema.parse(await ipcRenderer.invoke(IPC.teamsAudioStatus, { sessionToken })),
    start: async (sessionToken: string) => teamsAudioStartResultSchema.parse(await ipcRenderer.invoke(IPC.teamsAudioStart, { sessionToken })),
    stop: async () => {
      z.void().parse(await ipcRenderer.invoke(IPC.teamsAudioStop));
    },
    onLines: (listener: (lines: TeamsAudioLines) => void): (() => void) => {
      const handler = (_event: unknown, payload: unknown) => {
        const parsed = teamsAudioLinesSchema.safeParse(payload);
        if (parsed.success) listener(parsed.data);
      };
      ipcRenderer.on(IPC.teamsAudioLines, handler);
      return () => {
        ipcRenderer.removeListener(IPC.teamsAudioLines, handler);
      };
    },
    onEnded: (listener: (ended: TeamsAudioEnded) => void): (() => void) => {
      const handler = (_event: unknown, payload: unknown) => {
        const parsed = teamsAudioEndedSchema.safeParse(payload);
        if (parsed.success) listener(parsed.data);
      };
      ipcRenderer.on(IPC.teamsAudioEnded, handler);
      return () => {
        ipcRenderer.removeListener(IPC.teamsAudioEnded, handler);
      };
    },
    // macOS: asks for Screen Recording once, then opens Privacy & Security → Screen Recording.
    openScreenRecordingSettings: async () => {
      z.void().parse(await ipcRenderer.invoke(IPC.openScreenRecordingSettings));
    },
  },
  teams: {
    tick: async (sessionToken: string) => teamsTickResultSchema.parse(await ipcRenderer.invoke(IPC.teamsTick, { sessionToken })),
    act: async (action: TeamsAction) => teamsActionResultSchema.parse(await ipcRenderer.invoke(IPC.teamsAction, action)),
    publish: async (request: TeamsPublishRequest) =>
      teamsPublishResultSchema.parse(await ipcRenderer.invoke(IPC.teamsPublish, request)),
  },
};

export type BeeApi = typeof api;

contextBridge.exposeInMainWorld("bee", withFailureReports(api));
// Clerk's token cache and OAuth transport, used by @clerk/electron/react.
exposeClerkBridge();
