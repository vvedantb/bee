// The pill's one line of status text. No React or window here, so tests can call it.
import { activityLabel } from "./island";
import type { BeeState } from "./store";

export function notchStatus(state: BeeState, signedIn: boolean | undefined): string {
  if (signedIn === undefined) return "Loading…";
  if (!signedIn) return "Sign in to use Bee";
  if (state.busy) return activityLabel(state.activity);
  // The phrase ended and speech-to-text is running. No words are shown.
  if (state.heard) return "Got it…";
  if (state.mic.error) return state.mic.error;
  const tip = state.result?.tips[0];
  if (tip) return tip;
  if (state.settings?.gatewayKeySource === "none") return "Add your AI Gateway key in Settings";
  if (state.mic.on || state.session.lines.length > 0) return "Listening for something useful…";
  return state.settings?.meetingMode ? "Meeting mode on" : "Bee is ready";
}
