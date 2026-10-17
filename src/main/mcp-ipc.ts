import { ipcMain } from "electron";
import { testMcpServer } from "../core/mcp";
import {
  IPC,
  mcpIdSchema,
  mcpSaveSchema,
  mcpSetEnabledSchema,
  type McpTestResult,
} from "../shared/ipc";
import type { SettingsStore } from "./settings";

/** MCP server settings. Secrets are written and read here; the renderer only sees views. */
export function registerMcpIpc(settings: SettingsStore): void {
  ipcMain.handle(IPC.mcpList, () => settings.mcpList());
  ipcMain.handle(IPC.mcpSave, (_event, payload) => settings.mcpSave(mcpSaveSchema.parse(payload)));
  ipcMain.handle(IPC.mcpRemove, (_event, payload) => settings.mcpRemove(mcpIdSchema.parse(payload).id));
  ipcMain.handle(IPC.mcpSetEnabled, (_event, payload) => settings.mcpSetEnabled(mcpSetEnabledSchema.parse(payload)));

  // Connects, lists tools and saves the list (keeping each known tool's switch). Failures come back as values.
  ipcMain.handle(IPC.mcpTest, async (_event, payload): Promise<McpTestResult> => {
    const config = settings.mcpConfig(mcpIdSchema.parse(payload).id);
    if (!config) return { ok: false, error: "That server no longer exists" };
    const outcome = await testMcpServer(config);
    if (!outcome.ok) return { ok: false, error: outcome.error };
    return { ok: true, tools: settings.mcpRecordTools(config.id, outcome.tools) };
  });
}
