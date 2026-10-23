// The pill's status text and logo state. No React or window here, so tests can call them.
import { activityLabel } from "./island";
import type { LogoState } from "./logo";
import type { BeeState } from "./store";

type LogoInputs = Pick<BeeState, "busy" | "tools" | "done" | "mic" | "error" | "result" | "summary" | "mcp" | "update" | "teamsError">;

/**
 * The notch logo's state. Any error wins, then a tool call in flight (web search over the others), then a busy run,
 * then the one-shot done after tips, then an open mic.
 */
export function logoState(state: LogoInputs): LogoState {
  // A new run hides the last run's guide error (store.ts displayResult), so it counts only when idle.
  const guideError = state.busy ? null : state.result?.guideError;
  const failed = [state.error, state.mic.error, guideError, state.summary.error, state.mcp.error, state.update.error, state.teamsError];
  if (failed.some(Boolean)) return "error";
  if (state.tools.includes("web_search")) return "searching";
  if (state.tools.length > 0) return "tool";
  if (state.busy) return "thinking";
  if (state.done) return "done";
  if (state.mic.on) return "listening";
  return "idle";
}

export function notchStatus(state: BeeState, signedIn: boolean | undefined): string {
  if (signedIn === undefined) return "Loading…";
  if (!signedIn) return "Sign in to use Bee";
  // Tips stay on screen while a newer line updates them.
  if (state.busy) return state.revising ? "Updating…" : activityLabel(state.activity);
  // The phrase ended and speech-to-text is running. No words are shown.
  if (state.heard) return "Got it…";
  if (state.mic.error) return state.mic.error;
  const tip = state.result?.tips[0];
  if (tip) return tip;
  if (state.settings?.gatewayKeySource === "none") return "Add your AI Gateway key in Settings";
  if (state.mic.on || state.session.lines.length > 0) return "Listening for something useful…";
  return state.settings?.meetingMode ? "Meeting mode on" : "Bee is ready";
}
