// The pill's status text and logo state. No React or window here, so tests can call them.
import { activityLabel } from "./island";
import type { LogoState } from "./logo";
import type { SettingsView } from "../../shared/ipc";
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

/**
 * What the pill's status text is about, so a click on it can open the right place (island-click.ts statusClick). answer: the
 * first tip; working: a run (thinking, answering, searching, reading notes, updating) or speech-to-text in flight; idle:
 * listening, meeting mode or ready.
 */
export type NotchStatusKind = "loading" | "sign-in" | "working" | "mic-error" | "answer" | "gateway-key" | "idle";

export type NotchLine = { kind: NotchStatusKind; text: string };

type LineInputs = Pick<BeeState, "busy" | "revising" | "tools" | "question" | "heard" | "mic" | "result"> & {
  settings: Pick<SettingsView, "gatewayKeySource" | "meetingMode"> | null;
  session: Pick<BeeState["session"], "lines">;
};

/** The pill's status text and what it is about. */
export function notchLine(state: LineInputs, signedIn: boolean | undefined): NotchLine {
  if (signedIn === undefined) return { kind: "loading", text: "Loading…" };
  if (!signedIn) return { kind: "sign-in", text: "Sign in to use Bee" };
  // Tips stay on screen while a newer line updates them.
  if (state.busy) return { kind: "working", text: workingLabel(state) };
  // The phrase ended and speech-to-text is running. No words are shown.
  if (state.heard) return { kind: "working", text: "Got it…" };
  if (state.mic.error) return { kind: "mic-error", text: state.mic.error };
  const tip = state.result?.tips[0];
  if (tip) return { kind: "answer", text: tip };
  if (state.settings?.gatewayKeySource === "none") return { kind: "gateway-key", text: "Add your AI Gateway key in Settings" };
  if (state.mic.on || state.session.lines.length > 0) return { kind: "idle", text: "Listening for something useful…" };
  return { kind: "idle", text: state.settings?.meetingMode ? "Meeting mode on" : "Bee is ready" };
}

export function notchStatus(state: BeeState, signedIn: boolean | undefined): string {
  return notchLine(state, signedIn).text;
}
