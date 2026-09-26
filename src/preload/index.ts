import { contextBridge, ipcRenderer } from "electron";
import { z } from "zod";
import {
  IPC,
  pipelineResultSchema,
  settingsViewSchema,
  type PipelineRequest,
  type SettingsUpdate,
} from "../shared/ipc";

// The only surface the renderer can reach. Every response is parsed before it crosses the bridge.
const api = {
  getSettings: async () => settingsViewSchema.parse(await ipcRenderer.invoke(IPC.getSettings)),
  saveSettings: async (update: SettingsUpdate) =>
    settingsViewSchema.parse(await ipcRenderer.invoke(IPC.saveSettings, update)),
  runPipeline: async (request: PipelineRequest) =>
    pipelineResultSchema.parse(await ipcRenderer.invoke(IPC.runPipeline, request)),
  setExpanded: async (expanded: boolean) => {
    z.void().parse(await ipcRenderer.invoke(IPC.setExpanded, expanded));
  },
  openNotesFolder: async () => {
    z.string().parse(await ipcRenderer.invoke(IPC.openNotesFolder));
  },
};

export type BeeApi = typeof api;

contextBridge.exposeInMainWorld("bee", api);
