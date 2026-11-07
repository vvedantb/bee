import { debugLog, errorData, setDebugSink, teeConsole, type DebugData, type DebugEvent, type DebugLevel, type DebugSink } from "../../core/debug-log";
import { redactDebugData } from "../../core/debug-redact";
import { DEBUG_BATCH_MAX, type DebugLogBatch, type DebugLogEvent } from "../../shared/ipc";
import type { BeeState } from "./store";

// The renderer's side of the local debug log (core/debug-log.ts): events are batched and sent to main, which redacts them again
// and writes them under the user data folder (main/debug-log.ts). Nothing is uploaded. Events are already redacted here, so no
// secret crosses IPC either. Sending is fire and forget: a lost batch never affects Bee.

/** How long an event waits before its batch goes to main. */
export const RENDERER_FLUSH_MS = 1000;

// Main's event schema (shared/ipc.ts debugLogEventSchema): a name that does not fit is cleaned rather than lost.
const cleanName = (name: string, pattern: RegExp, other: RegExp, max: number): string => {
  if (pattern.test(name)) return name;
  const clean = name.toLowerCase().replace(other, "-").replace(/^[^a-z]+/, "").slice(0, max);
  return clean || "unnamed";
};
const CATEGORY = /^[a-z][a-z0-9-]{0,39}$/;
const EVENT = /^[a-z][a-z0-9._-]{0,79}$/i;

export type RendererDebugSink = DebugSink & { flush: () => void; pending: () => number };

/** Queues events and sends them to main in batches, on a timer or when a batch is full. Time and sending are injected for tests. */
export function createRendererDebugSink(args: {
  send: (batch: DebugLogBatch) => void;
  now?: () => number;
  flushMs?: number;
}): RendererDebugSink {
  const now = args.now ?? Date.now;
  let queue: DebugLogEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    while (queue.length > 0) {
      const events = queue.slice(0, DEBUG_BATCH_MAX);
      queue = queue.slice(DEBUG_BATCH_MAX);
      try {
        args.send({ events });
      } catch {
        // Main is gone (reload, quit): the batch is dropped.
      }
    }
  };

  return {
    // Every level: the log is always detailed (no setting).
    wants: () => true,
    write: (event: DebugEvent) => {
      const data = event.data === undefined ? undefined : (redactDebugData(event.data) as DebugData);
      queue.push({
        ts: now(),
        level: event.level,
        category: cleanName(event.category, CATEGORY, /[^a-z0-9-]+/g, 40),
        event: cleanName(event.event, EVENT, /[^a-z0-9._-]+/g, 80),
        ...(data ? { data } : {}),
      });
      if (queue.length >= DEBUG_BATCH_MAX) flush();
      else timer ??= setTimeout(flush, args.flushMs ?? RENDERER_FLUSH_MS);
    },
    flush,
    pending: () => queue.length,
  };
}

/** A short, one-way tag for the signed-in user, so sessions can be told apart without the id itself. */
export async function userTag(userId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`bee-debug-log:${userId}`));
  return [...new Uint8Array(digest).slice(0, 6)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Sign-in state for the log: signed in or out, and the user's tag. Never a token or the id. */
export async function logSignIn(signedIn: boolean, userId: string | null | undefined): Promise<void> {
  const tag = signedIn && userId ? await userTag(userId).catch(() => null) : null;
  debugLog.info("auth", signedIn ? "signed-in" : "signed-out", { signedIn, user: tag });
}

/** The parts of the store that describe the island and panel, small enough to compare on every change. Mic level is left out. */
export function uiSnapshot(state: BeeState): Record<string, unknown> {
  return {
    expanded: state.expanded,
    collapsing: state.collapsing,
    tab: state.tab,
    busy: state.busy,
    heard: state.heard,
    question: state.question,
    revising: state.revising,
    dismissed: state.dismissed,
    islandClosing: state.islandClosing,
    fullText: state.fullText,
    tools: state.tools,
    error: state.error,
    hint: state.hint?.id ?? null,
    meetingCard: state.meetingCard?.id ?? null,
    computer: state.computer ? { runId: state.computer.runId, step: state.computer.step, confirm: state.computer.confirm?.id ?? null } : null,
    tips: state.result?.tips.length ?? 0,
    partialTips: state.partialTips?.length ?? null,
    guideError: state.result?.guideError ?? null,
    chips: state.chips.length - state.dismissedChipIds.length,
    mic: { on: state.mic.on, error: state.mic.error },
    teamsAudio: { listening: state.teamsAudio.listening, failure: state.teamsAudio.failure },
    sync: state.teams?.room?.id ?? null,
    syncPrompt: state.teams?.prompt?.epoch ?? null,
    summary: { saving: state.summary.saving, error: state.summary.error },
    update: state.update.status,
  };
}

/** Logs which island and panel fields each store change touched, with their new values (debug level). */
export function logStateChanges(subscribe: (listener: () => void) => () => void, read: () => BeeState): () => void {
  let last: Record<string, string> = {};
  const seen = (snapshot: Record<string, unknown>) => Object.fromEntries(Object.entries(snapshot).map(([key, value]) => [key, JSON.stringify(value)]));
  last = seen(uiSnapshot(read()));
  return subscribe(() => {
    if (!debugLog.wants("debug")) return;
    const snapshot = uiSnapshot(read());
    const next = seen(snapshot);
    const changed = Object.keys(next).filter((key) => next[key] !== last[key]);
    last = next;
    if (changed.length > 0) debugLog.debug("ui", "state", Object.fromEntries(changed.map((key) => [key, snapshot[key]])));
  });
}

/**
 * Installs the renderer's sink and its watchers: console output, uncaught errors and rejections, focus, visibility and size. The
 * queue goes to main when the page hides or unloads.
 */
export function installRendererDebugLog(args: { send: (batch: DebugLogBatch) => void }): RendererDebugSink {
  const sink = createRendererDebugSink(args);
  setDebugSink(sink);
  teeConsole(console);
  window.addEventListener("error", (event) => {
    debugLog.error("renderer", "error", { message: event.message, source: event.filename, line: event.lineno, column: event.colno, error: errorData(event.error) });
  });
  window.addEventListener("unhandledrejection", (event) => debugLog.error("renderer", "unhandled-rejection", { error: errorData(event.reason) }));
  window.addEventListener("focus", () => debugLog.debug("ui", "window-focus"));
  window.addEventListener("blur", () => debugLog.debug("ui", "window-blur"));
  document.addEventListener("visibilitychange", () => debugLog.debug("ui", "visibility", { state: document.visibilityState }));
  let resized: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener("resize", () => {
    clearTimeout(resized);
    resized = setTimeout(() => debugLog.debug("ui", "window-resize", { width: window.innerWidth, height: window.innerHeight, ratio: window.devicePixelRatio }), 250);
  });
  window.addEventListener("pagehide", () => sink.flush());
  window.addEventListener("beforeunload", () => sink.flush());
  debugLog.info("renderer", "start", {
    language: navigator.language,
    width: window.innerWidth,
    height: window.innerHeight,
    ratio: window.devicePixelRatio,
    reducedMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? null,
  });
  return sink;
}
