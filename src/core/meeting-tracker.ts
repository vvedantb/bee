// Debounces the raw "Teams is in a call" reading. The popup waits for a stable reading; leaving waits out short
// gaps. Each new stable detection gets a new epoch, so a gap never silently rejoins an old sync.

export const ENTER_STABLE_MS = 10_000;
export const LEAVE_DEBOUNCE_MS = 15_000;

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
