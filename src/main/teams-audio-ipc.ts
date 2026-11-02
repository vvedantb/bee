import { ipcMain, shell } from "electron";
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
  ipcMain.handle(IPC.teamsAudioStatus, async (_event, payload) => {
    assertSignedIn(teamsAudioStatusRequestSchema.parse(payload).sessionToken);
    const status = await args.status();
    args.capture.touch();
    if (args.capture.running() && !teamsAudioAllowed(status, args.enabled())) args.capture.stop("policy");
    return status;
  });

  ipcMain.handle(IPC.teamsAudioStart, async (_event, payload): Promise<TeamsAudioStartResult> => {
    assertSignedIn(teamsAudioStartRequestSchema.parse(payload).sessionToken);
    const status = await args.status();
    if (!teamsAudioAllowed(status, args.enabled())) return { ok: false, failure: "refused" };
    return args.capture.start();
  });

  ipcMain.handle(IPC.teamsAudioStop, () => {
    args.capture.stop("renderer");
  });

  ipcMain.handle(IPC.openScreenRecordingSettings, async () => {
    if (!args.isMac) return;
    // The first time, macOS shows its own prompt and lists Bee in the pane; after that it only opens the pane.
    if ((await args.capture.requestPermission()) !== "granted") await shell.openExternal(MAC_SCREEN_RECORDING_SETTINGS);
  });
}
