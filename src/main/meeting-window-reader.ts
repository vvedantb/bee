import {
  parseAccessibility,
  parseApps,
  parseFindCount,
  parseSnapshotTree,
  parseWindows,
  type AdApp,
  type AdNode,
  type AdWindow,
  type AgentDesktopFailure,
} from "../core/agent-desktop-envelope";
import {
  EMPTY_CAPTIONS,
  captionStep,
  detectMeetings,
  drillTargets,
  extractCaptionLines,
  extractParticipants,
  isPossibleTeamsCall,
  joinDrills,
  meetingReading,
  type CaptionLine,
  type CaptionMemory,
  type MeetingWindow,
  type MeetingWindowContext,
} from "../core/agent-desktop-meeting";
import type { DetectorReading } from "../core/teams-heuristics";
import type { MeetingWindowStatus } from "../shared/ipc";
import type { AgentDesktopRun } from "./agent-desktop";

// Experimental: "read meeting window" (Settings, off by default). With the setting on, Bee lists windows with agent-desktop to
// find a Teams, Zoom or Google Meet call on macOS and Windows, reads the Teams or Zoom call window's people and live captions,
// and hands new caption lines to the renderer. Read-only and headless: only list-apps, list-windows, find --count, snapshot
// and permissions run. A call window is read as a skeleton (a shallow map), then by drilling only the regions that can hold
// people and captions (snapshot --root), never as one deep snapshot of the whole window. Everything stays in memory. Console lines carry codes and counts only. Any failure falls back to the built-in
// detector (main/teams-detector.ts), which keeps running beside it.

export const READER_TIMING = {
  /** list-windows at most this often. */
  detectMs: 3000,
  /** list-apps (bundle ids, for app names that do not say what they are) at most this often. */
  appsMs: 60_000,
  /** A reading older than this is not used, and the caption loop stops. */
  staleMs: 20_000,
  /** A missing Accessibility grant (macOS) is checked again this often. */
  permissionMs: 10_000,
  /** A binary that would not run is tried again after this long. */
  unavailableMs: 5 * 60_000,
  /** The longest backoff after failed reads. */
  failMaxMs: 60_000,
  /** Caption poll while captions are visible. */
  captionMs: 1500,
  /** The longest wait between call window reads while no captions are visible. */
  captionIdleMaxMs: 30_000,
  /** A Teams window's Leave-button check is reused this long. */
  confirmMs: 60_000,
};

// The map: three levels, interactive nodes only, cut regions marked with children_count and a drill ref.
const SKELETON_ARGS = ["--skeleton", "-i", "--compact", "--timeout-ms", "2500"];
// A drill: all of one region's text (no -i, which drops caption and name text), deep enough for Chromium's nested groups.
const DRILL_ARGS = ["--compact", "--max-depth", "25", "--timeout-ms", "2500"];
const CAPTION_SPEAKER_MAX = 100;
const CAPTION_TEXT_MAX = 2000;
const CAPTION_BATCH_MAX = 50;

export type MeetingWindowReader = {
  /** The latest reading (never waits for agent-desktop), or null when off, failing or stale: use the built-in detector alone. */
  read: () => Promise<DetectorReading | null>;
  /** The call's name and people for retrieval and the brief. Null when off or no call window is read. */
  context: () => MeetingWindowContext | null;
  status: () => MeetingWindowStatus;
  /** Stops reading and forgets everything (quit). */
  stop: () => void;
};

export function createMeetingWindowReader(deps: {
  enabled: () => boolean;
  /** Null when the binary is not bundled for this platform. */
  run: AgentDesktopRun | null;
  onCaptions: (lines: CaptionLine[]) => void;
  /** Reading stopped (setting off, or quit). The runner deletes its state folder. */
  onIdle?: () => void;
  platform?: NodeJS.Platform;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => () => void;
  timing?: Partial<typeof READER_TIMING>;
  log?: { warn: (message: string) => void; debug: (message: string) => void };
}): MeetingWindowReader {
  const timing = { ...READER_TIMING, ...deps.timing };
  const clock = deps.now ?? Date.now;
  const platform = deps.platform ?? process.platform;
  const log = deps.log ?? { warn: (message: string) => console.warn(message), debug: (message: string) => console.debug(message) };
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return () => clearTimeout(timer);
    });

  let state: MeetingWindowStatus["state"] = "off";
  // Bumped when reading stops, so a command that finishes afterwards changes nothing.
  let epoch = 0;
  let reading: { at: number; value: DetectorReading } | null = null;
  let meetings: MeetingWindow[] = [];
  let apps: AdApp[] = [];
  let appsAt = -Infinity;
  const confirmed = new Map<string, { title: string; at: number; call: boolean }>();
  let permissionOk = false;
  let busy = false;
  let nextAt = -Infinity;
  let failures = 0;
  const warned = new Set<string>();

  // The Teams or Zoom call window whose people and captions are read.
  let target: MeetingWindow | null = null;
  let participants: string[] = [];
  let captionsVisible = false;
  let memory: CaptionMemory = EMPTY_CAPTIONS;
  let cancelTimer: (() => void) | null = null;
  let captionBusy = false;
  // Drill refs from the last skeleton. Re-drilled while captions show; mapped again when none show or a drill fails.
  let drills: string[] = [];
  let captionFailures = 0;
  let idleDelay = timing.captionMs;

  const fresh = (): boolean => reading !== null && clock() - reading.at <= timing.staleMs;

  function warnOnce(code: string): void {
    if (warned.has(code)) return;
    warned.add(code);
    log.warn(`Bee: meeting window reader: ${code}; using the built-in detector`);
  }

  function stopCaptions(): void {
    cancelTimer?.();
    cancelTimer = null;
    target = null;
    participants = [];
    captionsVisible = false;
    memory = EMPTY_CAPTIONS;
    captionFailures = 0;
    idleDelay = timing.captionMs;
    drills = [];
  }

  function forget(): void {
    reading = null;
    meetings = [];
    stopCaptions();
  }

  function reset(): void {
    epoch += 1;
    forget();
    state = "off";
    apps = [];
    appsAt = -Infinity;
    confirmed.clear();
    permissionOk = false;
    nextAt = -Infinity;
    failures = 0;
    deps.onIdle?.();
  }

  function unavailable(code: string): void {
    state = "unavailable";
    forget();
    nextAt = clock() + timing.unavailableMs;
    warnOnce(code);
  }

  function needsPermission(): void {
    // Outside macOS a denied grant means no accessibility bus at all (Linux without AT-SPI): nothing to ask the user for.
    if (platform !== "darwin") return unavailable("PERM_DENIED");
    state = "needs-permission";
    permissionOk = false;
    forget();
    nextAt = clock() + timing.permissionMs;
    warnOnce("PERM_DENIED");
  }

  function fail(code: string): void {
    if (code === "PERM_DENIED") return needsPermission();
    if (code === "SPAWN_FAILED" || code === "PLATFORM_NOT_SUPPORTED") return unavailable(code);
    failures += 1;
    nextAt = clock() + Math.min(timing.detectMs * 2 ** failures, timing.failMaxMs);
    warnOnce(code);
  }

  /** Teams titles that name a meeting without saying "meeting" or "call": a call window has a Leave button. Counted, not read. */
  async function confirmTeams(run: AgentDesktopRun, windows: readonly AdWindow[]): Promise<void> {
    const now = clock();
    for (const [id, entry] of confirmed) {
      if (now - entry.at >= timing.confirmMs || !windows.some((window) => window.id === id && window.title === entry.title)) confirmed.delete(id);
    }
    const unchecked = windows.filter((window) => isPossibleTeamsCall(window) && !confirmed.has(window.id)).slice(0, 2);
    for (const window of unchecked) {
      const result = await run("find", ["--app", window.app, "--window-id", window.id, "--role", "button", "--name", "Leave", "--count", "--timeout-ms", "2000"], { timeoutMs: 5000 });
      const count = result.ok ? parseFindCount(result.data) : null;
      confirmed.set(window.id, { title: window.title, at: now, call: (count ?? 0) > 0 });
    }
  }

  async function refresh(): Promise<void> {
    if (busy || clock() < nextAt) return;
    const run = deps.run;
    if (!run) return unavailable("NOT_BUNDLED");
    busy = true;
    const mine = epoch;
    try {
      if (!permissionOk) {
        const result = await run("permissions", [], { timeoutMs: 6000 });
        if (mine !== epoch) return;
        if (!result.ok) return fail(result.code);
        if (parseAccessibility(result.data) === "denied") return needsPermission();
        permissionOk = true;
      }
      if (clock() - appsAt >= timing.appsMs) {
        // Best effort: without bundle ids, app names still identify Teams, Zoom and the browsers.
        const listedApps = await run("list-apps", [], { timeoutMs: 6000 });
        if (mine !== epoch) return;
        appsAt = clock();
        if (listedApps.ok) apps = parseApps(listedApps.data);
      }
      const listed = await run("list-windows", ["--timeout-ms", "3000"], { timeoutMs: 6000 });
      if (mine !== epoch) return;
      if (!listed.ok) return fail(listed.code);
      const windows = parseWindows(listed.data);
      await confirmTeams(run, windows);
      if (mine !== epoch) return;
      const calls = new Set([...confirmed].filter(([, entry]) => entry.call).map(([id]) => id));
      meetings = detectMeetings({ windows, apps, confirmed: calls });
      reading = { at: clock(), value: meetingReading(meetings) };
      state = "ready";
      failures = 0;
      nextAt = clock() + timing.detectMs;
      followTarget();
    } catch {
      if (mine === epoch) fail("ERROR");
    } finally {
      busy = false;
    }
  }

  /** Reads the first Teams or Zoom call window. A different window starts afresh: what it already shows is not new. */
  function followTarget(): void {
    const next = meetings.find((meeting) => meeting.app === "teams" || meeting.app === "zoom") ?? null;
    if (!next) return stopCaptions();
    if (target?.windowId === next.windowId) {
      target = next;
      return;
    }
    stopCaptions();
    target = next;
    schedule(0);
  }

  function schedule(ms: number): void {
    cancelTimer?.();
    cancelTimer = setTimer(() => {
      cancelTimer = null;
      void readCallWindow();
    }, ms);
  }

  /**
   * The call window's people and captions regions as one tree: a skeleton to find the regions, then a drill into each. Kept
   * refs are drilled again without a new skeleton; when one fails (the window changed), the window is mapped once more.
   */
  async function readTree(run: AgentDesktopRun, window: MeetingWindow): Promise<{ ok: true; tree: AdNode | null } | AgentDesktopFailure> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const kept = drills.length > 0;
      if (!kept) {
        const skeleton = await run("snapshot", ["--app", window.appName, "--window-id", window.windowId, ...SKELETON_ARGS], { timeoutMs: 6000 });
        if (!skeleton.ok) return skeleton;
        drills = drillTargets(skeleton.data);
        if (drills.length === 0) return { ok: true, tree: null };
      }
      const trees: AdNode[] = [];
      let failed: AgentDesktopFailure | null = null;
      for (const ref of drills) {
        const result = await run("snapshot", ["--root", ref, ...DRILL_ARGS], { timeoutMs: 6000 });
        if (!result.ok) {
          failed = result;
          break;
        }
        const tree = parseSnapshotTree(result.data);
        if (tree) trees.push(tree);
      }
      if (!failed) return { ok: true, tree: joinDrills(trees) };
      drills = [];
      if (!kept || failed.code === "PERM_DENIED") return failed;
    }
    return { ok: false, code: "ERROR" };
  }

  const clip = (line: CaptionLine): CaptionLine => ({ speaker: line.speaker?.slice(0, CAPTION_SPEAKER_MAX) ?? null, text: line.text.slice(0, CAPTION_TEXT_MAX) });

  async function readCallWindow(): Promise<void> {
    const window = target;
    const run = deps.run;
    if (!window || !run || !deps.enabled()) return;
    // Nobody has asked for a reading lately (signed out, or the window closed): stop instead of polling on our own.
    if (!fresh()) return stopCaptions();
    if (captionBusy) return schedule(timing.captionMs);
    captionBusy = true;
    const started = clock();
    try {
      const result = await readTree(run, window);
      if (target !== window) return;
      let delay: number;
      if (!result.ok) {
        if (result.code === "PERM_DENIED") return fail(result.code);
        captionFailures += 1;
        delay = Math.min(timing.captionMs * 2 ** captionFailures, timing.failMaxMs);
      } else {
        captionFailures = 0;
        const tree = result.tree;
        participants = extractParticipants(tree);
        const captions = extractCaptionLines(tree);
        captionsVisible = captions.visible;
        // No captions in the drilled regions: map the window again next time, as a captions panel may have opened elsewhere.
        if (!captions.visible) drills = [];
        const step = captionStep(memory, captions.lines, clock());
        memory = step.memory;
        if (step.fresh.length > 0) {
          deps.onCaptions(step.fresh.slice(-CAPTION_BATCH_MAX).map(clip));
          log.debug(`perf meeting-window caption lines +${step.fresh.length}`);
        }
        // Captions showing: poll steadily. None: back off, so a call without captions costs one read every 30 s at most.
        idleDelay = captions.visible ? timing.captionMs : Math.min(Math.max(idleDelay * 2, timing.captionMs * 2), timing.captionIdleMaxMs);
        delay = idleDelay;
      }
      // Never faster than twice what the read took, so a slow app is not hammered.
      schedule(Math.max(delay, (clock() - started) * 2));
    } catch {
      if (target === window) schedule(timing.failMaxMs);
    } finally {
      captionBusy = false;
    }
  }

  /** The call Bee reads: the caption target when there is one, else the first (focused first) call window. */
  function current(): MeetingWindow | null {
    if (!fresh()) return null;
    return (target && meetings.find((meeting) => meeting.windowId === target?.windowId)) ?? meetings[0] ?? null;
  }

  return {
    async read() {
      if (!deps.enabled()) {
        if (state !== "off") reset();
        return null;
      }
      if (state === "off") state = "starting";
      void refresh();
      return fresh() ? (reading?.value ?? null) : null;
    },
    context() {
      if (!deps.enabled() || state !== "ready") return null;
      const meeting = current();
      if (!meeting) return null;
      return { app: meeting.app, title: meeting.name, participants: target?.windowId === meeting.windowId ? [...participants] : [] };
    },
    status() {
      if (!deps.enabled()) return { state: "off", app: null, captions: false };
      const meeting = state === "ready" ? current() : null;
      return { state: state === "off" ? "starting" : state, app: meeting?.app ?? null, captions: meeting !== null && target?.windowId === meeting.windowId && captionsVisible };
    },
    stop() {
      reset();
    },
  };
}
