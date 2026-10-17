import { ipcMain, shell } from "electron";
import { mcpUrlError, testMcpServer, type McpPool } from "../core/mcp";
import { authorizeMcpServer, createMcpOAuthProvider, revokeMcpOAuth } from "../core/mcp-oauth";
import type { VmemSearch } from "../core/vmem-history";
import {
  IPC,
  mcpIdSchema,
  mcpSaveSchema,
  mcpSetEnabledSchema,
  type McpServerView,
  type McpTestResult,
} from "../shared/ipc";
import { startLoopback } from "./mcp-oauth-loopback";
import type { SettingsStore } from "./settings";

/** Opens the sign-in page in the system browser. Only http(s): the address comes from the server's metadata. */
async function openAuthorization(url: URL): Promise<void> {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("The sign-in address is not safe to open");
  await shell.openExternal(url.href);
}

/** MCP server settings. Secrets are written and read here; the renderer only sees views. */
export function registerMcpIpc(settings: SettingsStore, vmem: VmemSearch, pool: McpPool): void {
  const signingIn = new Set<string>();
  // Every change that can add, remove or sign out the vmem connector re-checks the warm connection.
  // It also drops Luna's cached tool list and warm connection for that server (all servers when the id is not known).
  const changed = (servers: McpServerView[], id?: string): McpServerView[] => {
    vmem.refresh();
    void pool.invalidate(id);
    return servers;
  };

  ipcMain.handle(IPC.mcpList, () => settings.mcpList());
  ipcMain.handle(IPC.mcpSave, (_event, payload) => {
    const save = mcpSaveSchema.parse(payload);
    return changed(settings.mcpSave(save), save.id);
  });
  // Disconnect: ask the authorization server to revoke the tokens first (best effort, bounded), then clear them locally.
  ipcMain.handle(IPC.mcpRemove, async (_event, payload) => {
    const id = mcpIdSchema.parse(payload).id;
    const url = settings.mcpConfig(id)?.url;
    if (url) await revokeMcpOAuth({ url, state: settings.mcpOAuthStorage(id).load() });
    return changed(settings.mcpRemove(id), id);
  });
  ipcMain.handle(IPC.mcpSetEnabled, (_event, payload) => {
    const update = mcpSetEnabledSchema.parse(payload);
    return changed(settings.mcpSetEnabled(update), update.id);
  });

  // MCP sign-in: system browser, redirect to a loopback server on 127.0.0.1 (not bee://). Tokens are stored encrypted and never returned.
  // On success the server is switched on and its tools are saved. Errors throw, and show in the Connectors error line.
  ipcMain.handle(IPC.mcpAuthorize, async (_event, payload): Promise<McpServerView[]> => {
    const id = mcpIdSchema.parse(payload).id;
    const config = settings.mcpConfig(id);
    if (!config) throw new Error("That server no longer exists");
    if (config.transport !== "http" || config.auth.type !== "none") throw new Error("Sign-in needs a remote server without a token");
    const urlError = mcpUrlError(config.url);
    if (urlError || !config.url) throw new Error(urlError ?? "Enter a valid URL");
    if (signingIn.has(id)) throw new Error("Sign-in is already open in your browser");
    signingIn.add(id);
    const loopback = await startLoopback().catch((error: unknown) => {
      signingIn.delete(id);
      throw error;
    });
    try {
      const provider = createMcpOAuthProvider({ storage: settings.mcpOAuthStorage(id), redirectUrl: loopback.redirectUrl, redirectToAuthorization: openAuthorization });
      await authorizeMcpServer({ url: config.url, provider, code: loopback.waitForCode(() => provider.pendingState) });
    } finally {
      loopback.close();
      signingIn.delete(id);
    }
    const signedIn = settings.mcpConfig(id);
    if (!signedIn) throw new Error("That server no longer exists");
    // New tokens: connect fresh (this fills the tool cache), then switch the server on.
    await pool.invalidate(id);
    const outcome = await testMcpServer(signedIn, undefined, pool);
    if (!outcome.ok) throw new Error(outcome.error);
    settings.mcpRecordTools(id, outcome.tools);
    const views = settings.mcpSetEnabled({ id, enabled: true });
    vmem.refresh();
    return views;
  });

  // Connects, lists tools and saves the list (keeping each known tool's switch). Failures come back as values.
  ipcMain.handle(IPC.mcpTest, async (_event, payload): Promise<McpTestResult> => {
    const config = settings.mcpConfig(mcpIdSchema.parse(payload).id);
    if (!config) return { ok: false, error: "That server no longer exists" };
    const outcome = await testMcpServer(config, undefined, pool);
    if (!outcome.ok) return { ok: false, error: outcome.error };
    return { ok: true, tools: settings.mcpRecordTools(config.id, outcome.tools) };
  });
}
