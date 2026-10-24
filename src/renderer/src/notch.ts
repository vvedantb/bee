// The pill's status text and logo state. No React or window here, so tests can call them.
import { activityLabel } from "./island";
import type { LogoState } from "./logo";
import type { BeeState } from "./store";

/** The notch's round, raised size="sm" buttons (mic off, collapse). The logo is as tall as they are (logo.ts NOTCH_LOGO_PX). */
export const NOTCH_BUTTON = "rounded-full bg-[var(--surface-raised)] hover:bg-[#2d271e]";

/** The notch's update button (App.tsx UpdateButton), a size="icon-sm" Button. Shown only when an update is available. */
export const NOTCH_UPDATE_BUTTON = "notch-update bg-[var(--surface-raised)] hover:bg-[#2d271e]";

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

export const ANSWERING_LABEL = "The AI is answering…";

/**
 * The pill while a run is busy, shown from the moment a line lands (before anything streams). A tool call in flight wins (web
 * search over the others), then "Updating…" while kept tips are revised, then answering a question, then thinking.
 */
export function workingLabel(state: Pick<BeeState, "tools" | "revising" | "question">): string {
  const tool = state.tools.includes("web_search") ? "web_search" : state.tools.at(-1);
  if (tool) return activityLabel(tool);
  if (state.revising) return "Updating…";
  return state.question ? ANSWERING_LABEL : activityLabel(null);
}

export function notchStatus(state: BeeState, signedIn: boolean | undefined): string {
  if (signedIn === undefined) return "Loading…";
  if (!signedIn) return "Sign in to use Bee";
  // Tips stay on screen while a newer line updates them.
  if (state.busy) return workingLabel(state);
  // The phrase ended and speech-to-text is running. No words are shown.
  if (state.heard) return "Got it…";
  if (state.mic.error) return state.mic.error;
  const tip = state.result?.tips[0];
  if (tip) return tip;
  if (state.settings?.gatewayKeySource === "none") return "Add your AI Gateway key in Settings";
  if (state.mic.on || state.session.lines.length > 0) return "Listening for something useful…";
  return state.settings?.meetingMode ? "Meeting mode on" : "Bee is ready";
}
