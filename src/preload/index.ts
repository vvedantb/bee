import { exposeClerkBridge } from "@clerk/electron/preload";
import { contextBridge, ipcRenderer } from "electron";
import { z } from "zod";
import {
  IPC,
  lunaActivitySchema,
  mcpListSchema,
  mcpTestResultSchema,
  meetingSummaryResultSchema,
  openExternalUrlResultSchema,
  pipelineResultSchema,
  settingsViewSchema,
  teamsActionResultSchema,
  teamsPublishResultSchema,
  teamsTickResultSchema,
  transcribeResultSchema,
  updateActionSchema,
  updateCheckSchema,
  type McpSave,
  type McpSetEnabled,
  type MeetingSummaryRequest,
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
  runPipeline: async (request: PipelineRequest) =>
    pipelineResultSchema.parse(await ipcRenderer.invoke(IPC.runPipeline, request)),
  transcribe: async (request: TranscribeRequest) =>
    transcribeResultSchema.parse(await ipcRenderer.invoke(IPC.transcribe, request)),
  writeMeetingSummary: async (request: MeetingSummaryRequest) =>
    meetingSummaryResultSchema.parse(await ipcRenderer.invoke(IPC.writeMeetingSummary, request)),
  // Resolves to shell.openPath's error message, "" on success.
  openMeetingSummary: async (path: string) => z.string().parse(await ipcRenderer.invoke(IPC.openMeetingSummary, path)),
  // Opens one http(s) link in the default browser after a click. Main re-checks the URL.
  openExternalUrl: async (url: string) => openExternalUrlResultSchema.parse(await ipcRenderer.invoke(IPC.openExternalUrl, url)),
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
  // Tool activity while a run is in flight. Returns the unsubscribe function.
  onLunaActivity: (listener: (tool: string) => void): (() => void) => {
    const handler = (_event: unknown, payload: unknown) => {
      const parsed = lunaActivitySchema.safeParse(payload);
      if (parsed.success) listener(parsed.data.tool);
    };
    ipcRenderer.on(IPC.lunaActivity, handler);
    return () => {
      ipcRenderer.removeListener(IPC.lunaActivity, handler);
    };
  },
  // MCP servers. Views carry hasAuth and env key names only; secrets never come back.
  mcp: {
    list: async () => mcpListSchema.parse(await ipcRenderer.invoke(IPC.mcpList)),
    save: async (server: McpSave) => mcpListSchema.parse(await ipcRenderer.invoke(IPC.mcpSave, server)),
    remove: async (id: string) => mcpListSchema.parse(await ipcRenderer.invoke(IPC.mcpRemove, { id })),
    setEnabled: async (update: McpSetEnabled) => mcpListSchema.parse(await ipcRenderer.invoke(IPC.mcpSetEnabled, update)),
    test: async (id: string) => mcpTestResultSchema.parse(await ipcRenderer.invoke(IPC.mcpTest, { id })),
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
