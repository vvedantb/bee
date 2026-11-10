import type { DetectorReading } from "../core/teams-heuristics";
import {
  callAudioTarget,
  teamsAudioPlan,
  teamsAudioPlatform,
  teamsAudioSupport,
  type CallAudioTarget,
  type CallWindow,
  type TeamsAudioHost,
  type TeamsAudioSupport,
} from "../core/teams-audio";
import { TEAMS_CALL_LEAVE_MS } from "../core/meeting-tracker";
import type { TeamsAudioStatus } from "../shared/ipc";
import type { TeamsAudioPermission } from "./teams-audio-capture";

// Call audio status for the renderer: can this build hear one app alone here (platform, OS floor, helper installed), and which
// call is on (Teams, Zoom or Google Meet). The renderer gets codes only; the target (process names, bundle ids, pid) stays in
// main. No Electron imports, so tests inject everything. The renderer decides to listen (core/teams-audio.ts teamsAudioPlan)
// and asks main to start the helper (main/teams-audio-capture.ts); main checks again with teamsAudioAllowed.

/** What main reads each poll: the status the renderer sees, and the app the helper should hear (null: none). */
export type TeamsAudioReading = { status: TeamsAudioStatus; target: CallAudioTarget | null };

export function createTeamsAudioStatus(deps: {
  enabled: () => boolean;
  /** The built-in detector alone (main/teams-detector.ts): desktop Teams only, Windows only. */
  readTeamsDetector: () => Promise<DetectorReading>;
  /** The meeting window reader: the call window it reads (app, process, bundle id). */
  reader: { call: () => CallWindow | null };
  platform?: string;
  /** Tests only: which platforms have a per-app capture path. */
  appAudio?: Parameters<typeof teamsAudioSupport>[1];
  /** The OS floor and whether the helper is installed. Absent: only the build is checked. */
  host?: TeamsAudioHost;
  /** macOS Screen Recording, as the last capture found it (main/teams-audio-capture.ts). */
  permission?: () => TeamsAudioPermission;
  now?: () => number;
}): () => Promise<TeamsAudioReading> {
  const platform = teamsAudioPlatform(deps.platform ?? process.platform);
  const support: TeamsAudioSupport = teamsAudioSupport(platform, deps.appAudio, deps.host);
  const now = deps.now ?? Date.now;
  // A call stays on through brief gaps in the signal: it ends only after TEAMS_CALL_LEAVE_MS of continuous absence, so a flap
  // neither stops the capture nor starts a new session. A different app seen meanwhile replaces the target at once.
  let target: CallAudioTarget | null = null;
  let lastSeen = 0;
  return async () => {
    // Only macOS asks for a permission (Screen Recording); Windows process loopback needs none.
    const permission = platform === "mac" && support.supported ? (deps.permission?.() ?? "unknown") : "not-needed";
    const base: TeamsAudioStatus = { platform, ...support, call: null, permission };
    // Off, or no per-app capture here: nothing to detect, so nothing runs.
    if (!deps.enabled() || !support.supported) {
      // Turning it off is the user's call: no grace.
      target = null;
      return { status: base, target: null };
    }
    // Fail open: a failed read is no signal this time, so no new call starts; a call already on keeps its grace.
    let seen: CallAudioTarget | null = null;
    try {
      const builtIn = await deps.readTeamsDetector().catch(() => null);
      seen = callAudioTarget({ window: deps.reader.call(), teamsDetector: Boolean(builtIn?.inMeeting) });
    } catch {
      seen = null;
    }
    const at = now();
    if (seen) {
      target = seen;
      lastSeen = at;
    } else if (target !== null && at - lastSeen >= TEAMS_CALL_LEAVE_MS) target = null;
    return { status: { ...base, call: target?.kind ?? null }, target };
  };
}

/**
 * Main's own check before it starts the helper, and on every status poll while it runs: the setting is on, the platform is
 * supported, and a call Bee can hear is on. The mic is the renderer's to know; it asks only with the mic on and stops the
 * capture when the mic goes off.
 */
export function teamsAudioAllowed(status: TeamsAudioStatus, enabled: boolean): boolean {
  return teamsAudioPlan({ enabled, supported: status.supported, inCall: status.call !== null, micOn: true }) === "listen";
}
