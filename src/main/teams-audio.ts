import { teamsAudioPlan, teamsAudioPlatform, teamsAudioSupport, type TeamsAudioHost, type TeamsAudioSupport } from "../core/teams-audio";
import type { TeamsAudioStatus } from "../shared/ipc";
import type { TeamsAudioPermission } from "./teams-audio-capture";

// Call audio status for the renderer: can this build hear the computer's sound here (platform, OS floor, helper installed).
// Bee hears all system audio while its mic is on, so there is no call app to find. No Electron imports, so tests inject
// everything. The renderer decides to listen (core/teams-audio.ts teamsAudioPlan) and asks main to start the helper
// (main/teams-audio-capture.ts); main checks again with teamsAudioAllowed.

export function createTeamsAudioStatus(deps: {
  enabled: () => boolean;
  platform?: string;
  /** Tests only: which platforms have a capture path. */
  appAudio?: Parameters<typeof teamsAudioSupport>[1];
  /** The OS floor and whether the helper is installed. Absent: only the build is checked. */
  host?: TeamsAudioHost;
  /** macOS Screen Recording, as the last capture found it (main/teams-audio-capture.ts). */
  permission?: () => TeamsAudioPermission;
}): () => Promise<TeamsAudioStatus> {
  const platform = teamsAudioPlatform(deps.platform ?? process.platform);
  const support: TeamsAudioSupport = teamsAudioSupport(platform, deps.appAudio, deps.host);
  return async () => {
    // Only macOS asks for a permission (Screen Recording); Windows loopback needs none.
    const permission = platform === "mac" && support.supported ? (deps.permission?.() ?? "unknown") : "not-needed";
    return { platform, ...support, permission };
  };
}

/**
 * Main's own check before it starts the helper: the setting is on and the platform is supported. The mic is the renderer's to
 * know; it asks only with the mic on and stops the capture when the mic goes off.
 */
export function teamsAudioAllowed(status: TeamsAudioStatus, enabled: boolean): boolean {
  return teamsAudioPlan({ enabled, supported: status.supported, micOn: true }) === "listen";
}
