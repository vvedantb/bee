import { clipboard, ipcMain, type IpcMainInvokeEvent } from "electron";
import { RENDERER_HOST, RENDERER_SCHEME } from "../shared/clerk";
import { IPC, type CopyGatewayKeyResult } from "../shared/ipc";

/** True only for the main frame of Bee's own window, on its bee://renderer/ page. */
export function isTrustedSender(sender: { webContentsId: number; frameUrl: string | undefined; isMainFrame: boolean }, windowId: number | undefined): boolean {
  if (windowId === undefined || sender.webContentsId !== windowId || !sender.isMainFrame || !sender.frameUrl) return false;
  try {
    const url = new URL(sender.frameUrl);
    return url.protocol === `${RENDERER_SCHEME}:` && url.host === RENDERER_HOST;
  } catch {
    return false;
  }
}

function trusted(event: IpcMainInvokeEvent, windowId: number | undefined): boolean {
  const frame = event.senderFrame;
  return isTrustedSender({ webContentsId: event.sender.id, frameUrl: frame?.url, isMainFrame: frame !== null && frame.parent === null }, windowId);
}

/** Reveal and copy for the saved Gateway key, after a click in Settings. Other senders get an error; the key is never logged. */
export function registerGatewayKeyIpc(args: { savedKey: () => string | undefined; windowId: () => number | undefined }): void {
  ipcMain.handle(IPC.revealGatewayKey, (event): string | null => {
    if (!trusted(event, args.windowId())) throw new Error("Not allowed");
    return args.savedKey() ?? null;
  });
  ipcMain.handle(IPC.copyGatewayKey, (event): CopyGatewayKeyResult => {
    if (!trusted(event, args.windowId())) throw new Error("Not allowed");
    const key = args.savedKey();
    if (key) clipboard.writeText(key);
    return { copied: Boolean(key) };
  });
}
