// Loop controls for computer use ("Bee, send Sam a message in Slack", core/computer-use.ts): a time limit, and
// stop (the user said "Bee, stop", pressed Stop, cancelled a confirm, or a newer request came). Pure: timers only, no Electron
// or OS, so tests drive it with fake timers.

import { debugLog } from "./debug-log";

/**
 * Why a run ended early. user: Stop, "Bee, stop" or a newer request. declined: the user did not confirm an action. loop: the same
 * tool call kept giving the same result (core/loop-guard.ts). steps: only with a step limit, which tests set.
 */
export type StopReason = "user" | "steps" | "time" | "permission" | "declined" | "loop";

/** What can need a confirm (core/computer-gate.ts): sending, deleting, buying, submitting a form. */
export type IrreversibleKind = "send" | "delete" | "buy" | "submit";

/** Wall clock for one request, not counting time spent waiting for the user's Confirm. */
export const COMPUTER_MAX_MS = 3 * 60_000;
/** How long a Confirm waits for a tap. No answer reads as Cancel. */
export const CONFIRM_TIMEOUT_MS = 60_000;

export type RunControl = {
  /** Aborts when the run stops for any reason: tool calls and agent-desktop commands in flight end with it. */
  readonly signal: AbortSignal;
  reason: () => StopReason | null;
  /** The kind of action the user did not confirm, when reason is declined. */
  declined: () => IrreversibleKind | null;
  steps: () => number;
  /** Counts one tool step. Once stopped, or over a step limit when one was set, returns false (and stops the run with "steps"). */
  step: () => boolean;
  stop: (reason: StopReason, declined?: IrreversibleKind) => void;
  /** Runs work with the clock paused, so time spent waiting for a Confirm tap does not count. */
  paused: <T>(work: () => Promise<T>) => Promise<T>;
  /** Clears the timer and the parent listener. Safe to call more than once. */
  dispose: () => void;
};

/** Thrown into the signal, so callers can tell a stop from a network error. */
export class ComputerStopped extends Error {
  constructor(readonly reason: StopReason) {
    super(`computer use stopped: ${reason}`);
    this.name = "ComputerStopped";
  }
}

/**
 * A run's controls. parent: the request's own signal (a newer request or the renderer cancelling it) stops it as "user". No step
 * limit unless maxSteps is given (tests): a run goes on until the AI is done, the user stops it, the clock runs out or the loop
 * guard trips (core/loop-guard.ts).
 */
export function createRunControl(args: { maxSteps?: number; maxMs?: number; signal?: AbortSignal } = {}): RunControl {
  const maxSteps = args.maxSteps ?? Number.POSITIVE_INFINITY;
  const controller = new AbortController();
  let reason: StopReason | null = null;
  let declined: IrreversibleKind | null = null;
  let count = 0;
  let left = args.maxMs ?? COMPUTER_MAX_MS;
  let startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pauses = 0;

  const stop = (why: StopReason, kind?: IrreversibleKind) => {
    if (reason) return;
    debugLog.info("computer", "stopped", { reason: why, declined: kind ?? null, steps: count });
    reason = why;
    declined = why === "declined" ? (kind ?? null) : null;
    clearTimeout(timer);
    controller.abort(new ComputerStopped(why));
  };
  const arm = () => {
    startedAt = Date.now();
    timer = setTimeout(() => stop("time"), Math.max(0, left));
  };
  const onParent = () => stop("user");
  arm();
  if (args.signal?.aborted) stop("user");
  else args.signal?.addEventListener("abort", onParent, { once: true });

  return {
    signal: controller.signal,
    reason: () => reason,
    declined: () => declined,
    steps: () => count,
    step: () => {
      if (reason) return false;
      if (count >= maxSteps) {
        stop("steps");
        return false;
      }
      count += 1;
      return true;
    },
    stop,
    async paused(work) {
      if (pauses++ === 0) {
        clearTimeout(timer);
        left -= Date.now() - startedAt;
      }
      try {
        return await work();
      } finally {
        if (--pauses === 0 && !reason) arm();
      }
    },
    dispose: () => {
      clearTimeout(timer);
      args.signal?.removeEventListener("abort", onParent);
    },
  };
}

/**
 * The user's answer to a Confirm: true only for a Confirm tap. A stop, the timeout or a failed ask reads as false. ask gets a
 * signal that aborts once the answer is settled, so main can clear the prompt.
 */
export function awaitAnswer(ask: (signal: AbortSignal) => Promise<boolean>, parent: AbortSignal, timeoutMs = CONFIRM_TIMEOUT_MS): Promise<boolean> {
  const settled = new AbortController();
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      parent.removeEventListener("abort", onAbort);
      settled.abort();
      resolve(value);
    };
    const onAbort = () => finish(false);
    if (parent.aborted) return finish(false);
    parent.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish(false), timeoutMs);
    ask(settled.signal).then(
      (confirmed) => finish(confirmed === true),
      () => finish(false),
    );
  });
}

export type ComputerPlatform = "mac" | "windows";

const DECLINED: Record<IrreversibleKind, string> = {
  send: "Cancelled. Nothing was sent.",
  delete: "Cancelled. Nothing was deleted.",
  buy: "Cancelled. Nothing was bought.",
  submit: "Cancelled. The form was not submitted.",
};

/** macOS without Accessibility for Bee: the one line the island shows. Settings has the button. */
export const ACCESSIBILITY_LINE = "Bee needs Accessibility access. Allow it in Settings.";
/** Windows refused input: usually an app running as administrator. */
export const ELEVATED_LINE = "Windows blocked Bee from that app. It may be running as administrator.";

/** The one line a run that stopped early ends with. */
export function stopLine(reason: StopReason, detail: { maxSteps?: number; declined?: IrreversibleKind | null; platform?: ComputerPlatform } = {}): string {
  switch (reason) {
    case "user":
      return "Stopped.";
    case "steps":
      return detail.maxSteps !== undefined && Number.isFinite(detail.maxSteps) ? `Stopped after ${detail.maxSteps} steps.` : "Stopped.";
    case "loop":
      return "Stopped: Bee kept repeating the same step.";
    case "time":
      return "Stopped: that took too long.";
    case "permission":
      return detail.platform === "windows" ? ELEVATED_LINE : ACCESSIBILITY_LINE;
    case "declined":
      return detail.declined ? DECLINED[detail.declined] : "Cancelled.";
  }
}
