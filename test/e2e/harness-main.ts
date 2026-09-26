// E2E harness main process: Bee's real preload and meeting IPC (main/meeting-ipc.ts) and one test page.
// With BEE_E2E_AUDIO, Chromium's fake audio device plays that WAV to the page's mic. BEE_E2E_NOTES_DIR picks the notes
// folder (default: a new temp folder). Clerk is skipped: the page sends an unsigned token with Bee's issuer, which is
// all main/auth.ts checks.
import { BrowserWindow, app, session } from "electron";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLERK_ISSUER } from "../../src/main/auth";
import { registerMeetingIpc } from "../../src/main/meeting-ipc";
import { ensureNotesDir } from "../../src/main/notes";

const { BEE_E2E_PRELOAD: preload, BEE_E2E_PAGE: page, BEE_E2E_AUDIO: audioFile, BEE_E2E_NOTES_DIR: notesDirEnv } = process.env;
if (!preload || !page) throw new Error("BEE_E2E_PRELOAD and BEE_E2E_PAGE must be set");

if (audioFile) {
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
  app.commandLine.appendSwitch("use-file-for-fake-audio-capture", audioFile);
  app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
}

function fakeSessionToken(): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + 600;
  return `${part({ alg: "none" })}.${part({ iss: CLERK_ISSUER, sub: "user_e2e", exp })}.`;
}

void app.whenReady().then(() => {
  const notesDir = notesDirEnv || join(mkdtempSync(join(tmpdir(), "bee-e2e-")), "notes");
  ensureNotesDir(notesDir);
  registerMeetingIpc({ notesDir, gatewayApiKey: () => process.env.BEE_AI_GATEWAY_API_KEY?.trim() || undefined });
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === "media"));

  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.on("console-message", ({ message }) => {
    if (!message.startsWith("E2E_RESULT ")) return;
    process.stdout.write(`${message}\n`);
    app.exit(0);
  });
  void win.loadFile(page, { query: { token: fakeSessionToken() } });
});
