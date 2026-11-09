import type { DetectorReading } from "../core/teams-heuristics";
import { teamsAudioPlan, teamsAudioPlatform, teamsAudioSupport, type TeamsAudioHost, type TeamsAudioSupport } from "../core/teams-audio";
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
}): () => Promise<TeamsAudioStatus> {
  const platform = teamsAudioPlatform(deps.platform ?? process.platform);
  const support: TeamsAudioSupport = teamsAudioSupport(platform, deps.appAudio, deps.host);
  return async () => {
    // Only macOS asks for a permission (Screen Recording); Windows process loopback needs none.
    const permission = platform === "mac" && support.supported ? (deps.permission?.() ?? "unknown") : "not-needed";
    const base: TeamsAudioStatus = { platform, ...support, teamsCall: false, permission };
    // Off, or no Teams-only capture here: nothing to detect, so nothing runs.
    if (!deps.enabled() || !support.supported) return base;
    try {
      const builtIn = await deps.readTeamsDetector().catch(() => null);
      // Only Teams: a Zoom or Google Meet call never turns this on.
      const teamsCall = Boolean(builtIn?.inMeeting) || deps.reader.status().app === "teams";
      return { ...base, teamsCall };
    } catch {
      // Fail open: no call seen, so no listening; the mic carries on.
      return base;
    }
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
