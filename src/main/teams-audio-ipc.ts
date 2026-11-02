import { ipcMain, shell } from "electron";
import { debugLog } from "../core/debug-log";
import { IPC, teamsAudioStartRequestSchema, teamsAudioStatusRequestSchema, type TeamsAudioStartResult, type TeamsAudioStatus } from "../shared/ipc";
import { assertSignedIn } from "./auth";
import { teamsAudioAllowed } from "./teams-audio";
import type { TeamsAudioCapture } from "./teams-audio-capture";

// System Settings → Privacy & Security → Screen Recording (macOS 13+: "Screen & System Audio Recording" on macOS 15).
const MAC_SCREEN_RECORDING_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

/**
 * Teams audio fallback IPC. status: codes only, and a lease that keeps a running capture alive; a capture main would not start
 * now is stopped. start: main checks the plan itself before the helper runs. stop: the renderer's mic went off, or its plan
 * changed. The macOS Screen Recording button asks the system once, then opens the pane.
 */
export function registerTeamsAudioIpc(args: {
  status: () => Promise<TeamsAudioStatus>;
  enabled: () => boolean;
  capture: TeamsAudioCapture;
  isMac: boolean;
}): void {
  // Polled every few seconds: only a changed status is logged.
  let lastStatus = "";
  ipcMain.handle(IPC.teamsAudioStatus, async (_event, payload) => {
    assertSignedIn(teamsAudioStatusRequestSchema.parse(payload).sessionToken);
    const status = await args.status();
    const seen = JSON.stringify(status);
    if (seen !== lastStatus) {
      lastStatus = seen;
      debugLog.info("teams-audio", "status", { ...status, enabled: args.enabled(), running: args.capture.running() });
    }
    args.capture.touch();
    if (args.capture.running() && !teamsAudioAllowed(status, args.enabled())) {
      debugLog.info("teams-audio", "stop", { reason: "policy" });
      args.capture.stop("policy");
    }
    return status;
  });

  ipcMain.handle(IPC.teamsAudioStart, async (_event, payload): Promise<TeamsAudioStartResult> => {
    assertSignedIn(teamsAudioStartRequestSchema.parse(payload).sessionToken);
    const status = await args.status();
    if (!teamsAudioAllowed(status, args.enabled())) {
      debugLog.info("teams-audio", "start", { ok: false, failure: "refused", status });
      return { ok: false, failure: "refused" };
    }
    const result = await args.capture.start();
    debugLog.info("teams-audio", "start", result);
    return result;
  });

  ipcMain.handle(IPC.teamsAudioStop, () => {
    debugLog.info("teams-audio", "stop", { reason: "renderer" });
    args.capture.stop("renderer");
  });

  ipcMain.handle(IPC.openScreenRecordingSettings, async () => {
    if (!args.isMac) return;
    // The first time, macOS shows its own prompt and lists Bee in the pane; after that it only opens the pane.
    if ((await args.capture.requestPermission()) !== "granted") await shell.openExternal(MAC_SCREEN_RECORDING_SETTINGS);
  });
}
