import { createClerkBridge } from "@clerk/electron";
import { storage } from "@clerk/electron/storage";
import { BrowserWindow, Menu, Tray, app, desktopCapturer, globalShortcut, ipcMain, nativeImage, screen, session, shell, systemPreferences } from "electron";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RENDERER_HOST, RENDERER_SCHEME, RENDERER_URL } from "../shared/clerk";
import { IPC, settingsUpdateSchema, windowSizeSchema, type WindowSize } from "../shared/ipc";
import { registerMcpIpc } from "./mcp-ipc";
import { registerMeetingIpc } from "./meeting-ipc";
import { ensureNotesDir } from "./notes";
import { handleRendererProtocol } from "./renderer-protocol";
import { createSettingsStore } from "./settings";
import { findSystemAudioSource, isPermissionAllowed } from "./system-audio";
import { createTeamsDetector } from "./teams-detector";
import { inviteFromArgv, registerTeamsIpc, relayUrlFromEnv } from "./teams-sync";
import { createUpdater } from "./updater";

const SIZES: Record<WindowSize, { width: number; height: number }> = {
  collapsed: { width: 440, height: 64 },
  // Notch plus the Teams sync popup.
  prompt: { width: 440, height: 330 },
  // Notch plus the island body (tips and sources).
  response: { width: 440, height: 360 },
  expanded: { width: 480, height: 640 },
};
const TOP_MARGIN = 8;
const isMac = process.platform === "darwin";
const TOGGLE_SHORTCUT = "CommandOrControl+Shift+Space";

const outDir = fileURLToPath(new URL(".", import.meta.url));

let win: BrowserWindow | null = null;
let tray: Tray | null = null;

function topCentreBounds(size: { width: number; height: number }) {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(area.x + (area.width - size.width) / 2),
    y: area.y + TOP_MARGIN,
    ...size,
  };
}

function applyMeetingMode(window: BrowserWindow, meetingMode: boolean): void {
  // Meeting mode hides the overlay from screen sharing and lifts it above full-screen apps.
  window.setContentProtection(meetingMode);
  window.setAlwaysOnTop(true, meetingMode ? "screen-saver" : "floating");
}

function createWindow(meetingMode: boolean): BrowserWindow {
  const window = new BrowserWindow({
    ...topCentreBounds(SIZES.collapsed),
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    // A panel floats over full-screen apps on macOS without taking focus from them.
    ...(isMac ? { type: "panel" as const } : {}),
    show: false,
    title: "Bee",
    webPreferences: {
      preload: join(outDir, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  applyMeetingMode(window, meetingMode);
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.once("ready-to-show", () => window.show());
  // Links in Clerk's UI (terms, help) open in the browser; the overlay never opens windows.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  void window.loadURL(RENDERER_URL);
  return window;
}

function toggleWindow(): void {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else win.show();
}

function registerToggleShortcut(): void {
  try {
    if (!globalShortcut.register(TOGGLE_SHORTCUT, toggleWindow)) console.warn(`Bee: could not register ${TOGGLE_SHORTCUT}`);
  } catch (error) {
    console.warn("Bee: global shortcut unavailable:", error);
  }
}

function createTray(notesDir: string): void {
  try {
    const icon = nativeImage.createFromPath(join(app.getAppPath(), "resources/tray.png"));
    // The menu bar tints a template image to match light and dark.
    if (isMac) icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.setToolTip("Bee");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Show / hide Bee", click: toggleWindow },
        { label: "Open notes folder", click: () => void shell.openPath(notesDir) },
        { type: "separator" },
        { label: "Quit Bee", role: "quit" },
      ]),
    );
    // On macOS a click opens the menu; a click handler would fight it.
    if (!isMac) tray.on("click", toggleWindow);
  } catch (error) {
    // Some Linux desktops (and Xvfb) have no system tray. The overlay still works.
    console.warn("Bee: tray unavailable:", error);
  }
}

// Before whenReady: registers the bee:// scheme, Clerk's token and OAuth IPC, and the single-instance lock.
const clerk = createClerkBridge({
  storage: storage(),
  renderer: { scheme: RENDERER_SCHEME, host: RENDERER_HOST },
  userAgent: `Bee/${app.getVersion()}`,
});

// Set once IPC is registered; bee://team/… links that arrive earlier wait here.
let pendingInvite: string | null = inviteFromArgv(process.argv);
let onInvite: ((link: string) => void) | null = null;

function receiveInvite(link: string | null): void {
  if (!link) return;
  if (onInvite) onInvite(link);
  else pendingInvite = link;
  win?.show();
}

if (clerk.isPrimaryInstance) {
  app.on("second-instance", (_event, argv) => {
    win?.show();
    receiveInvite(inviteFromArgv(argv));
  });
  // macOS delivers deep links as open-url.
  app.on("open-url", (event, url) => {
    if (!/^bee:\/\/team\//i.test(url)) return;
    event.preventDefault();
    receiveInvite(url);
  });

  void app.whenReady().then(() => {
    // CI smoke test: the packaged app loaded every module and Clerk's storage. Skip the window, tray and mic.
    if (process.env.BEE_SMOKE_EXIT === "1") {
      process.stdout.write("BEE_SMOKE_OK\n");
      app.exit(0);
      return;
    }

    handleRendererProtocol(resolve(outDir, "../renderer"), process.env.ELECTRON_RENDERER_URL);

    const userDataDir = app.getPath("userData");
    const notesDir = join(userDataDir, "notes");
    ensureNotesDir(notesDir);
    const settings = createSettingsStore({
      userDataDir,
      notesDir,
      envGatewayKey: process.env.BEE_AI_GATEWAY_API_KEY,
    });

    // Menu bar app: no Dock icon.
    if (isMac) {
      app.dock?.hide();
      systemPreferences.askForMediaAccess("microphone").catch((error) => console.warn("Bee: microphone access request failed:", error));
    }

    // Microphone and screen capture only; every other permission is denied.
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
      callback(isPermissionAllowed(permission));
    });

    // getDisplayMedia without a picker: first screen plus loopback audio. Any failure leaves the renderer to use the mic alone.
    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
      void (async () => {
        try {
          const [screen] = await desktopCapturer.getSources({ types: ["screen"] });
          if (!screen) return callback({});
          try {
            callback({ video: screen, audio: "loopback" });
          } catch {
            callback({ video: screen });
          }
        } catch (error) {
          console.warn("Bee: system audio unavailable:", error);
          callback({});
        }
      })();
    });

    ipcMain.handle(IPC.getSettings, () => settings.view());

    ipcMain.handle(IPC.saveSettings, (_event, payload) => {
      const view = settings.save(settingsUpdateSchema.parse(payload));
      if (win) applyMeetingMode(win, view.meetingMode);
      return view;
    });

    registerMcpIpc(settings);
    registerMeetingIpc({ notesDir, fsRoots: settings.fsRoots, mcpConfigs: settings.mcpConfigs, gatewayApiKey: settings.gatewayApiKey });

    const teams = registerTeamsIpc({ relayUrl: relayUrlFromEnv(process.env.BEE_RELAY_URL || import.meta.env.MAIN_VITE_BEE_RELAY_URL), detector: createTeamsDetector() });
    onInvite = (link) => teams.setPendingInvite(link);
    if (pendingInvite) teams.setPendingInvite(pendingInvite);
    pendingInvite = null;

    ipcMain.handle(IPC.setWindowSize, (_event, payload) => {
      win?.setBounds(topCentreBounds(SIZES[windowSizeSchema.parse(payload)]));
    });

    ipcMain.handle(IPC.systemAudioSource, () => findSystemAudioSource());

    ipcMain.handle(IPC.openNotesFolder, () => shell.openPath(notesDir));

    const updater = createUpdater();
    ipcMain.handle(IPC.checkForUpdate, () => updater.check());
    ipcMain.handle(IPC.downloadUpdate, () => updater.download());
    ipcMain.handle(IPC.installUpdate, () => updater.install());

    win = createWindow(settings.view().meetingMode);
    createTray(notesDir);
    registerToggleShortcut();

    // macOS: re-create the overlay if it is gone, otherwise show it.
    app.on("activate", () => {
      if (win && !win.isDestroyed()) win.show();
      else win = createWindow(settings.view().meetingMode);
    });
  });

  app.on("will-quit", () => globalShortcut.unregisterAll());

  app.on("window-all-closed", () => app.quit());
}
