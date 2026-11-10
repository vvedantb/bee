// Debounces the raw "Teams is in a call" reading. The popup waits for a stable reading; leaving waits out short
// gaps. Each new stable detection gets a new epoch, so a gap never silently rejoins an old sync.

export const ENTER_STABLE_MS = 10_000;
/**
 * How long the in-call signal must stay absent before the call counts as over (the meeting ends, Teams audio stops). 45 s:
 * the window and mic readings flap for several seconds when Teams swaps windows (a share bar opens, a pop-out moves), and 15 s
 * cut a live capture mid-call. A real hang-up is still caught within a minute.
 */
export const TEAMS_CALL_LEAVE_MS = 45_000;
export const LEAVE_DEBOUNCE_MS = TEAMS_CALL_LEAVE_MS;

export type MeetingTracker = {
  raw: boolean;
  // When raw last changed.
  rawSince: number;
  stable: boolean;
  // When the current stable meeting began (the first raw "true" of it). Null when not in a meeting.
  since: number | null;
  // Increments on each new stable meeting.
  epoch: number;
};

export const IDLE_TRACKER: MeetingTracker = { raw: false, rawSince: 0, stable: false, since: null, epoch: 0 };

export function stepTracker(
  tracker: MeetingTracker,
  raw: boolean,
  now: number,
  timing: { enterMs: number; leaveMs: number } = { enterMs: ENTER_STABLE_MS, leaveMs: LEAVE_DEBOUNCE_MS },
): MeetingTracker {
  const next = raw === tracker.raw ? tracker : { ...tracker, raw, rawSince: now };
  if (!next.stable && next.raw && now - next.rawSince >= timing.enterMs) {
    return { ...next, stable: true, since: next.rawSince, epoch: next.epoch + 1 };
  }
  if (next.stable && !next.raw && now - next.rawSince >= timing.leaveMs) {
    return { ...next, stable: false, since: null };
  }
  return next;
}
