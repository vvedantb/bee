import { describe, expect, it } from "vitest";
import { ENTER_STABLE_MS, IDLE_TRACKER, LEAVE_DEBOUNCE_MS, stepTracker, type MeetingTracker } from "./meeting-tracker";

function feed(readings: Array<[number, boolean]>): MeetingTracker {
  let tracker = IDLE_TRACKER;
  for (const [at, raw] of readings) tracker = stepTracker(tracker, raw, at);
  return tracker;
}

describe("stepTracker", () => {
  it("waits for a stable reading before reporting a meeting", () => {
    expect(feed([[0, true], [ENTER_STABLE_MS - 1, true]]).stable).toBe(false);
    expect(feed([[0, true], [ENTER_STABLE_MS, true]])).toMatchObject({ stable: true, since: 0, epoch: 1 });
  });

  it("ignores flicker shorter than the enter delay", () => {
    expect(feed([[0, true], [5000, false], [6000, true], [ENTER_STABLE_MS + 1000, true]]).stable).toBe(false);
  });

  it("debounces leaving and keeps the same epoch across a short gap", () => {
    const inMeeting: Array<[number, boolean]> = [[0, true], [ENTER_STABLE_MS, true]];
    const gap = feed([...inMeeting, [20_000, false], [20_000 + LEAVE_DEBOUNCE_MS - 1, false], [40_000, true]]);
    expect(gap).toMatchObject({ stable: true, epoch: 1 });
    expect(feed([...inMeeting, [20_000, false], [20_000 + LEAVE_DEBOUNCE_MS, false]])).toMatchObject({ stable: false, since: null, epoch: 1 });
  });

  it("gives a new meeting after a real gap a new epoch", () => {
    const ended = feed([[0, true], [ENTER_STABLE_MS, true], [20_000, false], [20_000 + LEAVE_DEBOUNCE_MS, false]]);
    const next = [[60_000, true], [60_000 + ENTER_STABLE_MS, true]] as const;
    let tracker = ended;
    for (const [at, raw] of next) tracker = stepTracker(tracker, raw, at);
    expect(tracker).toMatchObject({ stable: true, epoch: 2, since: 60_000 });
  });
});
