import { BrowserWindow, app, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { RENDERER_HOST, RENDERER_SCHEME } from "../shared/clerk";
import { createClerkOAuthLoopback } from "./clerk-oauth-loopback";

// @clerk/electron's OAuth transport channels (OAUTH_TRANSPORT_CHANNELS; the package does not export them).
export const CLERK_OAUTH_CHANNELS = {
  getRedirectUrl: "clerk:oauth-transport:get-redirect-url",
  open: "clerk:oauth-transport:open",
} as const;

/** Shows, restores and focuses Bee's window. On macOS Bee is a menu bar app, so it must take focus from the browser. */
export function bringToFront(window: BrowserWindow | null | undefined): void {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  if (process.platform === "darwin") app.focus({ steal: true });
}

/** The main frame of a window on bee://renderer/. The bridge's own handlers check only for a window's main frame. */
function fromRenderer(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  if (event.sender.getType() !== "window" || !frame || frame !== event.sender.mainFrame) return false;
  try {
    const url = new URL(frame.url);
    return url.protocol === `${RENDERER_SCHEME}:` && url.host === RENDERER_HOST;
  } catch {
    return false;
  }
}

/**
 * Replaces the OAuth handlers createClerkBridge registered with ones that use the loopback page, so the browser ends on
 * Bee's page and not on the provider's. Call right after createClerkBridge; its token-cache handlers, bee:// scheme and
 * single-instance lock stay as they are. Returns a cleanup that ends a waiting sign-in.
 */
export function registerClerkOAuthIpc(options: { port?: number; timeoutMs?: number } = {}): () => void {
  const loopback = createClerkOAuthLoopback({ ...options, openExternal: (url) => shell.openExternal(url) });
  for (const channel of Object.values(CLERK_OAUTH_CHANNELS)) ipcMain.removeHandler(channel);

  ipcMain.handle(CLERK_OAUTH_CHANNELS.getRedirectUrl, (event) => {
    if (!fromRenderer(event)) throw new Error("Not allowed");
    return loopback.redirectUrl;
  });

  // Electron logs a rejection ("Error occurred in handler for …") and passes it to the renderer.
  ipcMain.handle(CLERK_OAUTH_CHANNELS.open, async (event, url: unknown) => {
    if (!fromRenderer(event)) throw new Error("Not allowed");
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await loopback.open(url);
    bringToFront(window);
    return result;
  });

  return () => {
    loopback.cancel();
    for (const channel of Object.values(CLERK_OAUTH_CHANNELS)) ipcMain.removeHandler(channel);
  };
}
