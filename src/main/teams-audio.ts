import type { MeetingWindowContext } from "../core/agent-desktop-meeting";
import type { DetectorReading } from "../core/sync-controller";
import { teamsAudioCoverage, teamsAudioPlan, teamsAudioPlatform, teamsAudioSupport, type TeamsAudioHost, type TeamsAudioSupport } from "../core/teams-audio";
import type { MeetingWindowStatus, TeamsAudioStatus, TeamsView } from "../shared/ipc";
import type { TeamsAudioPermission } from "./teams-audio-capture";

// Teams audio fallback status for the renderer: can this build hear the Teams app alone here (platform, OS floor, helper
// installed), is a Teams call on, and does everyone in it have Bee in this sync. Names stay in main; the reply carries codes
// only. No Electron imports, so tests inject everything. The renderer decides to listen (core/teams-audio.ts teamsAudioPlan)
// and asks main to start the helper (main/teams-audio-capture.ts); main checks again with teamsAudioAllowed.

export function createTeamsAudioStatus(deps: {
  enabled: () => boolean;
  /** The built-in detector alone (main/teams-detector.ts): desktop Teams only, Windows only. */
  readTeamsDetector: () => Promise<DetectorReading>;
  /** The experimental meeting window reader: which call it sees, and that call's roster. */
  reader: { status: () => MeetingWindowStatus; context: () => MeetingWindowContext | null };
  /** The Teams sync: room members, the user and any simulated meeting. */
  syncView: () => TeamsView;
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
    const base: TeamsAudioStatus = { platform, ...support, teamsCall: false, coverage: "unknown", permission };
    // Off, or no Teams-only capture here: nothing to detect, so nothing runs.
    if (!deps.enabled() || !support.supported) return base;
    try {
      const view = deps.syncView();
      const builtIn = await deps.readTeamsDetector().catch(() => null);
      const simulated = view.detection.source === "simulated" && view.detection.inMeeting;
      // Only Teams: a Zoom or Google Meet call never turns this on.
      const teamsCall = Boolean(builtIn?.inMeeting) || deps.reader.status().app === "teams" || simulated;
      const context = deps.reader.context();
      const coverage = teamsAudioCoverage({
        inRoom: view.room !== null,
        members: view.room?.members.map((member) => member.displayName) ?? [],
        self: view.me?.displayName ?? null,
        participants: context?.app === "teams" ? context.participants : null,
      });
      return { ...base, teamsCall, coverage };
    } catch {
      // Fail open: no call seen, so no listening; the mic and the sync carry on.
      return base;
    }
  };
}

/**
 * Main's own check before it starts the helper, and on every status poll while it runs: the setting is on, the platform is
 * supported, a Teams call is on and someone may not have Bee. The mic is the renderer's to know; it asks only with the mic on
 * and stops the capture when the mic goes off.
 */
export function teamsAudioAllowed(status: TeamsAudioStatus, enabled: boolean): boolean {
  return teamsAudioPlan({ enabled, supported: status.supported, teamsCall: status.teamsCall, micOn: true, coverage: status.coverage }) === "listen";
}
