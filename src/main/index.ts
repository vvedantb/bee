import { createClerkBridge } from "@clerk/electron";
import { storage } from "@clerk/electron/storage";
import { BrowserWindow, Menu, Tray, app, ipcMain, nativeImage, screen, session, shell } from "electron";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createBeeGateway } from "../core/gateway";
import { runPipeline } from "../core/pipeline";
import { RENDERER_HOST, RENDERER_SCHEME, RENDERER_URL } from "../shared/clerk";
import { IPC, pipelineRequestSchema, settingsUpdateSchema } from "../shared/ipc";
import { assertSignedIn } from "./auth";
import { ensureNotesDir, loadSnippets } from "./notes";
import { handleRendererProtocol } from "./renderer-protocol";
import { createSettingsStore } from "./settings";
import { createUpdater } from "./updater";

const COLLAPSED = { width: 440, height: 64 };
const EXPANDED = { width: 480, height: 640 };
const TOP_MARGIN = 8;

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
    ...topCentreBounds(COLLAPSED),
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
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

function createTray(notesDir: string): void {
  try {
    const icon = nativeImage.createFromPath(join(app.getAppPath(), "resources/tray.png"));
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
    tray.on("click", toggleWindow);
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

if (clerk.isPrimaryInstance) {
  app.on("second-instance", () => win?.show());

  void app.whenReady().then(() => {
    handleRendererProtocol(resolve(outDir, "../renderer"), process.env.ELECTRON_RENDERER_URL);

    const userDataDir = app.getPath("userData");
    const notesDir = join(userDataDir, "notes");
    ensureNotesDir(notesDir);
    const settings = createSettingsStore({
      userDataDir,
      notesDir,
      envGatewayKey: process.env.BEE_AI_GATEWAY_API_KEY,
    });

    // Microphone only; every other permission is denied.
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
      callback(permission === "media");
    });

    ipcMain.handle(IPC.getSettings, () => settings.view());

    ipcMain.handle(IPC.saveSettings, (_event, payload) => {
      const view = settings.save(settingsUpdateSchema.parse(payload));
      if (win) applyMeetingMode(win, view.meetingMode);
      return view;
    });

    ipcMain.handle(IPC.runPipeline, (_event, payload) => {
      const request = pipelineRequestSchema.parse(payload);
      assertSignedIn(request.sessionToken);
      const apiKey = settings.gatewayApiKey();
      return runPipeline({
        transcript: request.transcript,
        snippets: loadSnippets(notesDir),
        gateway: apiKey ? createBeeGateway(apiKey) : null,
      });
    });

    ipcMain.handle(IPC.setExpanded, (_event, payload) => {
      const expanded = z.boolean().parse(payload);
      win?.setBounds(topCentreBounds(expanded ? EXPANDED : COLLAPSED));
    });

    ipcMain.handle(IPC.openNotesFolder, () => shell.openPath(notesDir));

    const updater = createUpdater();
    ipcMain.handle(IPC.checkForUpdate, () => updater.check());
    ipcMain.handle(IPC.downloadUpdate, () => updater.download());
    ipcMain.handle(IPC.installUpdate, () => updater.install());

    win = createWindow(settings.view().meetingMode);
    createTray(notesDir);
  });

  app.on("window-all-closed", () => app.quit());
}
