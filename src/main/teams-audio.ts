import type { DetectorReading } from "../core/teams-heuristics";
import { teamsAudioPlan, teamsAudioPlatform, teamsAudioSupport, type TeamsAudioHost, type TeamsAudioSupport } from "../core/teams-audio";
import { TEAMS_CALL_LEAVE_MS } from "../core/meeting-tracker";
import type { MeetingWindowStatus, TeamsAudioStatus } from "../shared/ipc";
import type { TeamsAudioPermission } from "./teams-audio-capture";

// Teams audio fallback status for the renderer: can this build hear the Teams app alone here (platform, OS floor, helper
// installed), and is a Teams call on. The reply carries codes only. No Electron imports, so tests inject everything. The renderer decides to listen (core/teams-audio.ts teamsAudioPlan)
// and asks main to start the helper (main/teams-audio-capture.ts); main checks again with teamsAudioAllowed.

export function createTeamsAudioStatus(deps: {
  enabled: () => boolean;
  /** The built-in detector alone (main/teams-detector.ts): desktop Teams only, Windows only. */
  readTeamsDetector: () => Promise<DetectorReading>;
  /** The experimental meeting window reader: which call it sees. */
  reader: { status: () => MeetingWindowStatus };
  platform?: string;
  /** Tests only: which platforms have a Teams-only capture path. */
  appAudio?: Parameters<typeof teamsAudioSupport>[1];
  /** The OS floor and whether the helper is installed. Absent: only the build is checked. */
  host?: TeamsAudioHost;
  /** macOS Screen Recording, as the last capture found it (main/teams-audio-capture.ts). */
  permission?: () => TeamsAudioPermission;
  now?: () => number;
}): () => Promise<TeamsAudioStatus> {
  const platform = teamsAudioPlatform(deps.platform ?? process.platform);
  const support: TeamsAudioSupport = teamsAudioSupport(platform, deps.appAudio, deps.host);
  const now = deps.now ?? Date.now;
  // A call stays on through brief gaps in the signal: it ends only after TEAMS_CALL_LEAVE_MS of continuous absence, so a flap
  // neither stops the capture nor starts a new session.
  let inCallSince: number | null = null;
  let lastSeen = 0;
  return async () => {
    // Only macOS asks for a permission (Screen Recording); Windows process loopback needs none.
    const permission = platform === "mac" && support.supported ? (deps.permission?.() ?? "unknown") : "not-needed";
    const base: TeamsAudioStatus = { platform, ...support, teamsCall: false, permission };
    // Off, or no Teams-only capture here: nothing to detect, so nothing runs.
    if (!deps.enabled() || !support.supported) {
      // Turning it off is the user's call: no grace.
      inCallSince = null;
      return base;
    }
    // Fail open: a failed read is no signal this time, so no new call starts; a call already on keeps its grace.
    let seen = false;
    try {
      const builtIn = await deps.readTeamsDetector().catch(() => null);
      // Only Teams: a Zoom or Google Meet call never turns this on.
      seen = Boolean(builtIn?.inMeeting) || deps.reader.status().app === "teams";
    } catch {
      seen = false;
    }
    const at = now();
    if (seen) {
      inCallSince = inCallSince ?? at;
      lastSeen = at;
    } else if (inCallSince !== null && at - lastSeen >= TEAMS_CALL_LEAVE_MS) inCallSince = null;
    return { ...base, teamsCall: inCallSince !== null };
  };
}

/**
 * Main's own check before it starts the helper, and on every status poll while it runs: the setting is on, the platform is
 * supported, and a Teams call is on. The mic is the renderer's to know; it asks only with the mic on
 * and stops the capture when the mic goes off.
 */
export function teamsAudioAllowed(status: TeamsAudioStatus, enabled: boolean): boolean {
  return teamsAudioPlan({ enabled, supported: status.supported, teamsCall: status.teamsCall, micOn: true }) === "listen";
}
