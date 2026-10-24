import { exposeClerkBridge } from "@clerk/electron/preload";
import { contextBridge, ipcRenderer } from "electron";
import { z } from "zod";
import {
  IPC,
  enrichLinksResultSchema,
  faviconResultSchema,
  lunaActivitySchema,
  lunaPartialSchema,
  clearMeetingMemoryResultSchema,
  copyGatewayKeyResultSchema,
  meetingContextViewSchema,
  mcpListSchema,
  mcpTestResultSchema,
  meetingSummaryResultSchema,
  openExternalUrlResultSchema,
  pipelineResultSchema,
  revealGatewayKeyResultSchema,
  settingsViewSchema,
  teamsActionResultSchema,
  teamsPublishResultSchema,
  teamsTickResultSchema,
  transcribeResultSchema,
  updateActionSchema,
  updateCheckSchema,
  type EnrichLinksRequest,
  type LunaActivity,
  type LunaPartial,
  type McpSave,
  type McpSetEnabled,
  type MeetingSummaryRequest,
  type PipelineCancel,
  type PipelineRequest,
  type SettingsUpdate,
  type TeamsAction,
  type TeamsPublishRequest,
  type TranscribeRequest,
  type WindowSize,
} from "../shared/ipc";

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
  // Cancels a run a newer line has superseded. Fire and forget: the run's own result is dropped anyway.
  cancelPipeline: async (request: PipelineCancel) => {
    z.void().parse(await ipcRenderer.invoke(IPC.cancelPipeline, request));
  },
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
  setWindowSize: async (size: WindowSize) => {
    z.void().parse(await ipcRenderer.invoke(IPC.setWindowSize, size));
  },
  openNotesFolder: async () => {
    z.string().parse(await ipcRenderer.invoke(IPC.openNotesFolder));
  },
  checkForUpdate: async () => updateCheckSchema.parse(await ipcRenderer.invoke(IPC.checkForUpdate)),
  downloadUpdate: async () => updateActionSchema.parse(await ipcRenderer.invoke(IPC.downloadUpdate)),
  installUpdate: async () => updateActionSchema.parse(await ipcRenderer.invoke(IPC.installUpdate)),
  // A screen source id when system audio may be capturable, else null. The mic path never depends on it.
  systemAudioSource: async () => z.string().nullable().parse(await ipcRenderer.invoke(IPC.systemAudioSource)),
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
  teams: {
    tick: async (sessionToken: string) => teamsTickResultSchema.parse(await ipcRenderer.invoke(IPC.teamsTick, { sessionToken })),
    act: async (action: TeamsAction) => teamsActionResultSchema.parse(await ipcRenderer.invoke(IPC.teamsAction, action)),
    publish: async (request: TeamsPublishRequest) =>
      teamsPublishResultSchema.parse(await ipcRenderer.invoke(IPC.teamsPublish, request)),
  },
};

export type BeeApi = typeof api;

contextBridge.exposeInMainWorld("bee", api);
// Clerk's token cache and OAuth transport, used by @clerk/electron/react.
exposeClerkBridge();
