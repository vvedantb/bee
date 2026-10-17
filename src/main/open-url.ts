import { ipcMain, shell } from "electron";
import { safeExternalUrl } from "../core/url-safety";
import { IPC, openExternalUrlSchema, type OpenExternalUrlResult } from "../shared/ipc";

/** Opens a link chip's URL in the default browser. Only runs when the renderer asks after a click. */
export function registerOpenUrlIpc(): void {
  ipcMain.handle(IPC.openExternalUrl, async (_event, payload): Promise<OpenExternalUrlResult> => {
    const parsed = openExternalUrlSchema.safeParse(payload);
    const url = parsed.success ? safeExternalUrl(parsed.data) : null;
    if (!url) return { ok: false };
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });
}
