import { createClerkBridge } from "@clerk/electron";
import { storage } from "@clerk/electron/storage";
import { BrowserWindow, Menu, Tray, app, globalShortcut, ipcMain, nativeImage, screen, session, shell, systemPreferences } from "electron";
import { release } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RENDERER_HOST, RENDERER_SCHEME, RENDERER_URL } from "../shared/clerk";
import { displayMatching, placeInWorkArea, restoreOverlayBounds, scaleSize, type DisplayInfo } from "../core/interface-scale";
import { IPC, TEAMS_AUDIO_LINE_MAX, settingsUpdateSchema, windowSizeSchema, type MeetingWindowCaptions, type TeamsAudioEnded, type TeamsAudioLines, type WindowSize } from "../shared/ipc";
import { NO_GATEWAY_KEY, STT_MODEL, createBeeGateway } from "../core/gateway";
import { teamsAudioOsSupported, teamsAudioPlatform } from "../core/teams-audio";
import { transcribeSpeech } from "../core/transcribe";
import { createMcpPool } from "../core/mcp";
import { createMeetingContext } from "../core/meeting-context";
import { createMeetingMemoryStore } from "../core/meeting-memory";
import { searchMcpNotes } from "../core/meeting-search";
import { createVmemSearch } from "../core/vmem-history";
import { createAgentDesktopActionRunner, createAgentDesktopRunner, resolveAgentDesktop } from "./agent-desktop";
import { bringToFront, registerClerkOAuthIpc } from "./clerk-oauth-ipc";
import { createDesktopActions, windowsStartMenuDirs } from "./desktop-actions";
import { registerFaviconIpc } from "./favicon-ipc";
import { registerGatewayKeyIpc } from "./gateway-key-ipc";
import { registerLinkIpc } from "./link-ipc";
import { createCalendarReader, createWindowTitleReader } from "./local-readers";
import { registerMcpIpc } from "./mcp-ipc";
import { registerOpenUrlIpc } from "./open-url";
import { registerMeetingIpc } from "./meeting-ipc";
import { ensureNotesDir } from "./notes";
import { handleRendererProtocol } from "./renderer-protocol";
import { createSettingsStore, type SettingsStore } from "./settings";
import { isPermissionAllowed } from "./system-audio";
import { createMeetingWindowReader } from "./meeting-window-reader";
import { createTeamsAudioStatus } from "./teams-audio";
import { createTeamsAudioCapture } from "./teams-audio-capture";
import { resolveTeamsAudioHelper } from "./teams-audio-helper";
import { registerTeamsAudioIpc } from "./teams-audio-ipc";
import { createTeamsDetector, withMeetingWindow } from "./teams-detector";
import { inviteFromArgv, registerTeamsIpc, relayUrlFromEnv } from "./teams-sync";
import { createUpdater } from "./updater";

// One width in every state, so expanding only grows the height and the pill row never moves sideways.
const SIZES: Record<WindowSize, { width: number; height: number }> = {
  collapsed: { width: 480, height: 64 },
  // Notch plus the Teams sync popup.
  prompt: { width: 480, height: 330 },
  // Notch plus the island body (tips and sources).
  response: { width: 480, height: 360 },
  expanded: { width: 480, height: 640 },
};
const TOP_MARGIN = 8;
const isMac = process.platform === "darwin";
const TOGGLE_SHORTCUT = "CommandOrControl+Shift+Space";
// System Settings → Privacy & Security → Accessibility, for the experimental meeting window reader.
const MAC_ACCESSIBILITY_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

const outDir = fileURLToPath(new URL(".", import.meta.url));

let win: BrowserWindow | null = null;
// The current window mode, so a zoom change re-applies its bounds, not the collapsed ones.
let windowSize: WindowSize = "collapsed";
let interfaceScale = 1;
let tray: Tray | null = null;
// Set at start-up, before the first window.
let settings: SettingsStore;

function displayInfos(): DisplayInfo[] {
  return screen.getAllDisplays().map(({ id, bounds, workArea, scaleFactor }) => ({ id, bounds, workArea, scaleFactor }));
}

function rememberPosition(window: BrowserWindow): void {
  const bounds = window.getBounds();
  const display = displayMatching(bounds, displayInfos());
  if (display) settings.saveOverlayPosition({ x: bounds.x, y: bounds.y, displayId: display.id });
}

// Resize in place on the display the window is on; shift only to stay inside that work area.
function resizeOverlay(window: BrowserWindow, size: { width: number; height: number }): void {
  const current = window.getBounds();
  const display = displayMatching(current, displayInfos()) ?? displayInfos().find((item) => item.id === screen.getPrimaryDisplay().id);
  if (!display) return;
  window.setBounds(placeInWorkArea({ size, current, area: display.workArea, margin: TOP_MARGIN }));
  rememberPosition(window);
}

// Zoom every Bee window; the overlay also grows with its content so nothing clips.
function applyInterfaceScale(scale: number): void {
  interfaceScale = scale;
  for (const window of BrowserWindow.getAllWindows()) window.webContents.setZoomFactor(scale);
  if (win) resizeOverlay(win, scaleSize(SIZES[windowSize], scale));
}

function applyMeetingMode(window: BrowserWindow, meetingMode: boolean): void {
  // Meeting mode hides the overlay from screen sharing and lifts it above full-screen apps.
  window.setContentProtection(meetingMode);
  window.setAlwaysOnTop(true, meetingMode ? "screen-saver" : "floating");
}

function createWindow(meetingMode: boolean, scale: number): BrowserWindow {
  interfaceScale = scale;
  windowSize = "collapsed";
  const window = new BrowserWindow({
    ...restoreOverlayBounds({
      saved: settings.overlayPosition(),
      size: scaleSize(SIZES.collapsed, scale),
      displays: displayInfos(),
      primaryId: screen.getPrimaryDisplay().id,
      margin: TOP_MARGIN,
    }),
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
  // Zoom resets on navigation, so apply again once the page is up.
  window.webContents.on("did-finish-load", () => window.webContents.setZoomFactor(interfaceScale));
  // `moved` fires once a drag ends on Windows and macOS; Linux only emits `move`.
  if (process.platform === "linux") window.on("move", () => rememberPosition(window));
  else window.on("moved", () => rememberPosition(window));
  window.once("ready-to-show", () => window.show());
  // Links in Clerk's UI (terms, help) open in the browser; the overlay never opens windows.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.setZoomFactor(scale);
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
    // macOS: a black-and-alpha template the menu bar tints to match light and dark; the @2x sibling loads with it.
    const icon = nativeImage.createFromPath(join(app.getAppPath(), isMac ? "resources/trayTemplate.png" : "resources/tray.png"));
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

// Before whenReady: registers the bee:// scheme, Clerk's token and OAuth IPC, and the single-instance lock. Bee then
// swaps the OAuth IPC for its loopback (registerClerkOAuthIpc below).
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
  // Social sign-in returns the browser to Bee's page on 127.0.0.1, not to bee://renderer/ (main/clerk-oauth-loopback.ts).
  const stopClerkOAuth = registerClerkOAuthIpc();
  app.on("will-quit", stopClerkOAuth);

  // Also bee://renderer/ from Return to Bee on that page, on Windows and Linux.
  app.on("second-instance", (_event, argv) => {
    bringToFront(win);
    receiveInvite(inviteFromArgv(argv));
  });
  // macOS delivers deep links as open-url.
  app.on("open-url", (event, url) => {
    if (/^bee:\/\/team\//i.test(url)) {
      event.preventDefault();
      receiveInvite(url);
    } else if (/^bee:\/\/renderer(?:[/?#]|$)/i.test(url)) {
      // Return to Bee on the sign-in page.
      event.preventDefault();
      bringToFront(win);
    }
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
    settings = createSettingsStore({
      userDataDir,
      notesDir,
      envGatewayKey: process.env.BEE_AI_GATEWAY_API_KEY,
    });

    // Menu bar app: no Dock icon.
    if (isMac) {
      app.dock?.hide();
      systemPreferences.askForMediaAccess("microphone").catch((error) => console.warn("Bee: microphone access request failed:", error));
    }

    // Microphone only; every other permission, screen capture included, is denied.
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
      callback(isPermissionAllowed(permission));
    });

    // getDisplayMedia is always refused. Its only audio here is 'loopback' (all system audio), which Bee never captures; the
    // Teams audio fallback uses the native helper instead (main/teams-audio-capture.ts, ARCHITECTURE.md). The mic is unaffected.
    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));

    // Experimental meeting window reader (Settings, off by default): agent-desktop, read-only and headless. Missing binary or
    // any failure leaves the built-in detector on its own.
    const agentDesktopBinary = resolveAgentDesktop({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() });
    const agentDesktop = agentDesktopBinary ? createAgentDesktopRunner(agentDesktopBinary) : null;
    const meetingWindow = createMeetingWindowReader({
      enabled: settings.readMeetingWindow,
      run: agentDesktop?.run ?? null,
      onCaptions: (lines) => {
        if (win && !win.isDestroyed()) win.webContents.send(IPC.meetingWindowCaptions, { lines } satisfies MeetingWindowCaptions);
      },
      onIdle: () => agentDesktop?.cleanup(),
    });
    app.on("will-quit", () => meetingWindow.stop());
    // Desktop tools for a direct request ("Bee, open Teams"): their own agent-desktop runner (launch, focus and list only),
    // never the meeting window reader's. Apps open by fixed arguments or Electron's shell; nothing runs a shell.
    const desktopRunner = agentDesktopBinary ? createAgentDesktopActionRunner(agentDesktopBinary) : null;
    app.on("will-quit", () => desktopRunner?.cleanup());
    const desktop = createDesktopActions({
      platform: process.platform,
      run: desktopRunner?.run ?? null,
      openExternal: (url) => shell.openExternal(url),
      openPath: (path) => shell.openPath(path),
      startMenuDirs: windowsStartMenuDirs(process.env),
    });
    ipcMain.handle(IPC.openAccessibilitySettings, async () => {
      if (isMac) await shell.openExternal(MAC_ACCESSIBILITY_SETTINGS);
    });

    ipcMain.handle(IPC.getSettings, () => settings.view());

    ipcMain.handle(IPC.saveSettings, (_event, payload) => {
      const view = settings.save(settingsUpdateSchema.parse(payload));
      // Switching the meeting window reader on checks access at once; switching it off stops it at once.
      void meetingWindow.read();
      if (win) applyMeetingMode(win, view.meetingMode);
      applyInterfaceScale(view.interfaceScale);
      return view;
    });

    // Settings' eye and copy buttons. Only the overlay may ask, and only for the saved key.
    registerGatewayKeyIpc({ savedKey: settings.savedGatewayApiKey, windowId: () => (win && !win.isDestroyed() ? win.webContents.id : undefined) });

    // One open connection to the vmem connector for link chips. Opened now when signed in, and after each Connectors change.
    const vmemSearch = createVmemSearch(() => settings.vmemConfig());
    vmemSearch.refresh();
    app.on("will-quit", () => void vmemSearch.close());
    // Tool lists and warm connections for Luna's MCP tools, shared by the meeting and Connectors handlers.
    const mcpPool = createMcpPool();
    app.on("will-quit", () => void mcpPool.closeAll());
    registerMcpIpc(settings, vmemSearch, mcpPool);
    registerOpenUrlIpc();
    registerLinkIpc(settings, vmemSearch);
    registerFaviconIpc();
    // One detector for the Teams sync popup and for meeting context, so the in-call reading is shared and cached.
    const teamsDetector = createTeamsDetector();
    const detector = withMeetingWindow(teamsDetector, meetingWindow);
    // Which meeting the user is in: window titles and the classic Outlook calendar (Windows), saved meetings, connected tools.
    // The brief is built here in main and sent to Luna; saved meetings stay in meeting-memory.json in the user data folder.
    const teamsTitles = createWindowTitleReader();
    const meeting = createMeetingContext({
      inCall: async () => (await detector.read()).inMeeting,
      // While the call the meeting window reader sees is Zoom or Google Meet, an open Teams window does not name it.
      titles: { read: async () => (["zoom", "meet"].includes(meetingWindow.status().app ?? "") ? [] : teamsTitles.read()) },
      calendar: createCalendarReader(),
      memory: createMeetingMemoryStore({ path: join(userDataDir, "meeting-memory.json") }),
      searchNotes: (query) => searchMcpNotes({ configs: settings.mcpConfigs(), pool: mcpPool, query }),
      settings: settings.meetingContext,
      // macOS has no in-call detector, so it reads Teams window names on its own schedule.
      pollTitlesWhenIdle: isMac,
    });
    registerMeetingIpc({ notesDir, fsRoots: settings.fsRoots, mcpConfigs: settings.mcpConfigs, mcpSignedOut: settings.mcpSignedOut, mcpPool, meeting, meetingWindow, gatewayApiKey: settings.gatewayApiKey, desktop, wakeWordEnabled: settings.wakeWord });

    const teams = registerTeamsIpc({ relayUrl: relayUrlFromEnv(process.env.BEE_RELAY_URL || import.meta.env.MAIN_VITE_BEE_RELAY_URL), detector });
    onInvite = (link) => teams.setPendingInvite(link);
    if (pendingInvite) teams.setPendingInvite(pendingInvite);
    pendingInvite = null;

    // Teams audio fallback: the native helper hears the Teams app alone (process loopback on Windows, ScreenCaptureKit on
    // macOS); main reads its PCM, runs speech-to-text and sends text lines to the renderer. Status carries codes only; names
    // stay here. A missing helper, an old OS or a denied permission reads as not available, and the mic carries on.
    const teamsAudioHelper = resolveTeamsAudioHelper({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() });
    const sendToOverlay = (channel: string, payload: unknown): void => {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    };
    const teamsAudioCapture = createTeamsAudioCapture({
      helperPath: () => teamsAudioHelper,
      transcribe: (audio) => {
        const apiKey = settings.gatewayApiKey();
        if (!apiKey) return Promise.resolve({ text: null, error: NO_GATEWAY_KEY });
        return transcribeSpeech({ model: createBeeGateway(apiKey).transcription(STT_MODEL), audio });
      },
      onLines: (id, lines) => sendToOverlay(IPC.teamsAudioLines, { id, lines: lines.map((line) => line.slice(0, TEAMS_AUDIO_LINE_MAX)) } satisfies TeamsAudioLines),
      onEnded: (id, failure) => sendToOverlay(IPC.teamsAudioEnded, { id, failure } satisfies TeamsAudioEnded),
    });
    app.on("will-quit", () => teamsAudioCapture.stop());
    const teamsAudioStatus = createTeamsAudioStatus({
      enabled: settings.teamsAudioFallback,
      readTeamsDetector: teamsDetector.read,
      reader: meetingWindow,
      syncView: teams.view,
      host: { osSupported: teamsAudioOsSupported(teamsAudioPlatform(process.platform), release()), helperFound: teamsAudioHelper !== null },
      permission: teamsAudioCapture.permission,
    });
    registerTeamsAudioIpc({ status: teamsAudioStatus, enabled: settings.teamsAudioFallback, capture: teamsAudioCapture, isMac });

    ipcMain.handle(IPC.setWindowSize, (_event, payload) => {
      windowSize = windowSizeSchema.parse(payload);
      if (win) resizeOverlay(win, scaleSize(SIZES[windowSize], interfaceScale));
    });

    ipcMain.handle(IPC.openNotesFolder, () => shell.openPath(notesDir));

    const updater = createUpdater();
    ipcMain.handle(IPC.checkForUpdate, () => updater.check());
    ipcMain.handle(IPC.downloadUpdate, () => updater.download());
    ipcMain.handle(IPC.installUpdate, () => updater.install());

    win = createWindow(settings.view().meetingMode, settings.view().interfaceScale);
    createTray(notesDir);
    registerToggleShortcut();

    // macOS: re-create the overlay if it is gone, otherwise show it.
    app.on("activate", () => {
      if (win && !win.isDestroyed()) win.show();
      else win = createWindow(settings.view().meetingMode, settings.view().interfaceScale);
    });
  });

  app.on("will-quit", () => globalShortcut.unregisterAll());

  app.on("window-all-closed", () => app.quit());
}
