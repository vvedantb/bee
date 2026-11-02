// What Settings and the Live tab say about the Teams audio fallback. No React or window here, so tests can call it.
import type { TeamsAudioPlan } from "../../core/teams-audio";
import type { TeamsAudioStatus } from "../../shared/ipc";

/** The Teams audio fallback as the UI shows it: main's status, the store's plan (store.ts teamsAudioNow) and capture state. */
export type TeamsAudioView = { status: TeamsAudioStatus | null; plan: TeamsAudioPlan; listening: boolean; failed: boolean };

/** The Live tab line, and the Settings status, while Bee hears the Teams app. */
export const TEAMS_AUDIO_LISTENING = "Listening to Teams audio for people without Bee.";

const NOT_AVAILABLE: Record<TeamsAudioStatus["platform"], string> = {
  mac: "Teams audio fallback is not available on this Mac yet. Bee never records all system audio, so it uses your mic only.",
  windows: "Teams audio fallback is not available on Windows yet. Bee could only hear Teams by recording all system audio, which it never does, so it uses your mic only.",
  linux: "Teams audio fallback is not available on Linux. Bee uses your mic only.",
  other: "Teams audio fallback is not available on this device. Bee uses your mic only.",
};

/** The status line under the Teams audio switch. Null while it is off, or before main's first status. */
export function teamsAudioMessage(audio: TeamsAudioView | undefined): string | null {
  if (!audio?.status || audio.plan === "off") return null;
  if (!audio.status.supported) return NOT_AVAILABLE[audio.status.platform];
  if (audio.listening) return TEAMS_AUDIO_LISTENING;
  if (audio.failed) return "Could not hear Teams in this call. Bee carries on with your mic.";
  if (audio.plan === "covered") return "Everyone in this call has Bee, so Bee is not listening to Teams.";
  return "Bee listens to Teams in a Teams call with your mic on, when someone may not have Bee.";
}
