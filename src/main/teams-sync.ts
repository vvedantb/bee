import { clipboard, ipcMain } from "electron";
import { createSyncController, type SyncController } from "../core/sync-controller";
import { IPC, teamsActionSchema, teamsPublishRequestSchema, teamsTickRequestSchema } from "../shared/ipc";
import { assertSignedIn } from "./auth";
import type { TeamsDetector } from "./teams-detector";

// Teams mode IPC. Main holds the sync state and talks to the relay, so the renderer CSP stays closed to it.
// The renderer drives it: a tick every 2 s (detection, presence, phrases) and actions from the popup and Settings.

/** BEE_RELAY_URL, if it is an http(s) URL. Without it Teams mode is off. */
export function relayUrlFromEnv(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:" ? trimmed : null;
  } catch {
    return null;
  }
}

export function registerTeamsIpc(args: {
  relayUrl: string | null;
  detector: TeamsDetector;
  timing?: { enterMs: number; leaveMs: number };
}): SyncController {
  const sync = createSyncController({ relayUrl: args.relayUrl, readDetector: args.detector.read, timing: args.timing });

  ipcMain.handle(IPC.teamsTick, (_event, payload) => {
    const request = teamsTickRequestSchema.parse(payload);
    assertSignedIn(request.sessionToken);
    return sync.tick(request.sessionToken);
  });

  ipcMain.handle(IPC.teamsAction, async (_event, payload) => {
    const action = teamsActionSchema.parse(payload);
    assertSignedIn(action.sessionToken);
    const result = await sync.act(action);
    if (action.type === "copyInvite" && result.view.team) clipboard.writeText(result.view.team.inviteLink);
    return result;
  });

  ipcMain.handle(IPC.teamsPublish, (_event, payload) => {
    const request = teamsPublishRequestSchema.parse(payload);
    assertSignedIn(request.sessionToken);
    return sync.publish(request);
  });

  return sync;
}

/** The invite code in a bee://team/… deep link among process arguments, if any. */
export function inviteFromArgv(argv: string[]): string | null {
  return argv.find((arg) => /^bee:\/\/team\//i.test(arg)) ?? null;
}
