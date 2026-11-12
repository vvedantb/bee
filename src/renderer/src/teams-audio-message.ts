// What the Live tab says about call audio ("Hear other people in calls"). No React or window here, so tests can call it.
import type { TeamsAudioPlan } from "../../core/teams-audio";
import type { TeamsAudioFailure } from "../../core/teams-audio-protocol";
import type { TeamsAudioStatus } from "../../shared/ipc";

/** Call audio as the UI shows it: main's status, the store's plan (store.ts teamsAudioNow) and capture state. */
export type TeamsAudioView = { status: TeamsAudioStatus | null; plan: TeamsAudioPlan; listening: boolean; failed: boolean; failure?: TeamsAudioFailure | null };

const MIC_ONLY = "Bee uses your mic only.";
/** The Live → Meeting line while Bee hears the computer's sound. Not "Meeting in progress": only a started meeting says that (notch.ts). */
export const TEAMS_AUDIO_LISTENING = "Listening to your computer's sound.";
const CARRIES_ON = "Bee carries on with your mic.";
const MISSING = `The call audio helper is missing. Reinstall Bee. ${MIC_ONLY}`;

/** macOS counts any app's audio as Screen Recording. Bee's helper records the Mac's sound only, never the screen. */
export const TEAMS_AUDIO_SCREEN_RECORDING = "Turn on Screen Recording for Bee to hear other people in calls. Bee records your Mac's sound only, never your screen.";

function unavailable(status: TeamsAudioStatus): string {
  const { platform, reason } = status;
  if (platform === "linux") return `Call audio is not available on Linux. ${MIC_ONLY}`;
  if (platform === "other") return `Call audio is not available on this device. ${MIC_ONLY}`;
  if (reason === "os-too-old") {
    return platform === "mac" ? `Call audio needs macOS 13 or later. ${MIC_ONLY}` : `Call audio needs Windows 10 or later. ${MIC_ONLY}`;
  }
  if (reason === "helper-missing") return MISSING;
  return `Call audio is not available in this version of Bee. ${MIC_ONLY}`;
}

function failed(status: TeamsAudioStatus, failure: TeamsAudioFailure | null | undefined): string {
  const { platform } = status;
  if (failure === "missing") return MISSING;
  if (failure === "denied") return platform === "mac" ? TEAMS_AUDIO_SCREEN_RECORDING : `Windows would not let Bee hear the computer's sound. ${CARRIES_ON}`;
  if (failure === "unsupported") {
    const device = platform === "mac" ? "This Mac" : "This version of Windows";
    return `${device} cannot share its sound with Bee, so Bee uses your mic only.`;
  }
  return `Could not hear the computer's sound. Bee tries again shortly. ${CARRIES_ON}`;
}

/** macOS: the helper needs Screen Recording, so Live → Meeting shows the button that asks for it. */
export function teamsAudioNeedsScreenRecording(audio: TeamsAudioView | undefined): boolean {
  if (!audio?.status || audio.plan === "off" || audio.status.platform !== "mac" || !audio.status.supported || audio.listening) return false;
  return audio.failure === "denied" || audio.status.permission === "denied";
}

/** The status line under the call audio switch. Null while it is off, or before main's first status. */
export function teamsAudioMessage(audio: TeamsAudioView | undefined): string | null {
  if (!audio?.status || audio.plan === "off") return null;
  if (!audio.status.supported) return unavailable(audio.status);
  if (audio.listening) return TEAMS_AUDIO_LISTENING;
  if (teamsAudioNeedsScreenRecording(audio)) return TEAMS_AUDIO_SCREEN_RECORDING;
  if (audio.failed) return failed(audio.status, audio.failure);
  // Waiting for a call: the switch already says what it does.
  return null;
}
