import { describe, expect, it } from "vitest";
import {
  CONFIRM_CALENDAR_MS,
  CONFIRM_MS,
  END_GRACE_MS,
  IDLE_AUTO,
  MAX_MEETING_MS,
  qualifies,
  stepAutoMeeting,
  type AutoMeetingState,
  type AutoSignals,
} from "./auto-meeting-detection";

const NONE: AutoSignals = { meetingAppPresent: false, inCallTitle: false };
const CALL: AutoSignals = { meetingAppPresent: true, inCallTitle: true, micInUseByMeetingApp: true, identity: "weekly sync" };
const CHAT: AutoSignals = { meetingAppPresent: true, inCallTitle: false, micInUseByMeetingApp: false };
const WINDOW_CLOSED: AutoSignals = { meetingAppPresent: true, inCallTitle: false, micInUseByMeetingApp: true, identity: "weekly sync" };

// Runs the machine over (seconds, signals) steps. Effects are collected with the time they fired.
function run(steps: Array<[number, AutoSignals, { enabled?: boolean }?]>, from: AutoMeetingState = IDLE_AUTO) {
  let state = from;
  const effects: Array<{ at: number; effect: string }> = [];
  for (const [seconds, signals, options] of steps) {
    const out = stepAutoMeeting(state, { signals, enabled: options?.enabled ?? true, now: seconds * 1000 });
    state = out.state;
    if (out.effect !== "none") effects.push({ at: seconds, effect: out.effect });
  }
  return { state, effects };
}

// A call held from 0 to `upTo` seconds in steps of 1.
const hold = (signals: AutoSignals, from: number, upTo: number): Array<[number, AutoSignals]> =>
  Array.from({ length: upTo - from + 1 }, (_, i) => [from + i, signals]);

const CONFIRM_S = CONFIRM_MS / 1000;
const GRACE_S = END_GRACE_MS / 1000;

describe("thresholds", () => {
  it("keeps the grace in the 30 to 60 second range and confirmation short", () => {
    expect(END_GRACE_MS).toBeGreaterThanOrEqual(30_000);
    expect(END_GRACE_MS).toBeLessThanOrEqual(60_000);
    expect(CONFIRM_CALENDAR_MS).toBeLessThan(CONFIRM_MS);
  });
});

describe("start rule", () => {
  it("needs a meeting app and either the mic or an in-call title", () => {
    expect(qualifies(CALL)).toBe(true);
    expect(qualifies({ meetingAppPresent: true, inCallTitle: true })).toBe(true);
    expect(qualifies({ meetingAppPresent: true, inCallTitle: false, micInUseByMeetingApp: true })).toBe(true);
    expect(qualifies({ meetingAppPresent: false, inCallTitle: true, micInUseByMeetingApp: true })).toBe(false);
    expect(qualifies(CHAT)).toBe(false);
    expect(qualifies({ ...CHAT, calendarBoost: true })).toBe(false);
  });

  it("starts only after the signal holds for the confirmation time, and starts once", () => {
    const { effects, state } = run(hold(CALL, 0, CONFIRM_S + 20));
    expect(effects).toEqual([{ at: CONFIRM_S, effect: "start" }]);
    expect(state.phase).toBe("active");
    expect(state.startedAt).toBe(CONFIRM_S * 1000);
  });

  it("does not start when the signal breaks before the confirmation time", () => {
    const { effects, state } = run([...hold(CALL, 0, CONFIRM_S - 2), [CONFIRM_S - 1, NONE], ...hold(CALL, CONFIRM_S, CONFIRM_S + 3)]);
    expect(effects).toEqual([]);
    expect(state.phase).toBe("confirming");
    // The count restarted at the second run.
    expect(state.qualSince).toBe(CONFIRM_S * 1000);
  });

  it("lets a calendar event shorten confirmation, but never start alone", () => {
    const boosted = { ...CALL, calendarBoost: true };
    expect(run(hold(boosted, 0, 20)).effects).toEqual([{ at: CONFIRM_CALENDAR_MS / 1000, effect: "start" }]);
    expect(run(hold({ ...NONE, calendarBoost: true }, 0, 120)).effects).toEqual([]);
    expect(run(hold({ ...CHAT, calendarBoost: true }, 0, 120)).effects).toEqual([]);
  });

  it("does not start for chat-only Teams", () => {
    expect(run(hold(CHAT, 0, 120)).effects).toEqual([]);
  });

  it("does not start for a music app holding the mic (no meeting app)", () => {
    // The probe filters the mic to meeting apps, so a music app leaves both flags false.
    expect(run(hold({ meetingAppPresent: false, inCallTitle: false, micInUseByMeetingApp: false }, 0, 120)).effects).toEqual([]);
    // Even if a probe wrongly passed the mic through, no meeting app means no start.
    expect(run(hold({ meetingAppPresent: false, inCallTitle: false, micInUseByMeetingApp: true }, 0, 120)).effects).toEqual([]);
  });

  it("never starts with the setting off", () => {
    const steps = hold(CALL, 0, 120).map(([s, signals]): [number, AutoSignals, { enabled: boolean }] => [s, signals, { enabled: false }]);
    const { effects, state } = run(steps);
    expect(effects).toEqual([]);
    expect(state).toEqual(IDLE_AUTO);
  });

  it("starts when a platform has only the title signal (no mic probe)", () => {
    const titleOnly: AutoSignals = { meetingAppPresent: true, inCallTitle: true };
    expect(run(hold(titleOnly, 0, 20)).effects).toEqual([{ at: CONFIRM_S, effect: "start" }]);
  });
});

describe("end grace", () => {
  const started = () => run(hold(CALL, 0, CONFIRM_S));

  it("stops once, after the end condition holds for the full grace", () => {
    const base = CONFIRM_S;
    const { effects, state } = run([...hold(NONE, base + 1, base + GRACE_S + 60)], started().state);
    expect(effects).toEqual([{ at: base + 1 + GRACE_S, effect: "stop" }]);
    expect(state.phase).toBe("idle");
  });

  it("does not end on a brief drop inside the grace", () => {
    const base = CONFIRM_S;
    const steps = [...hold(NONE, base + 1, base + GRACE_S - 5), ...hold(CALL, base + GRACE_S - 4, base + GRACE_S + 100)];
    const { effects, state } = run(steps, started().state);
    expect(effects).toEqual([]);
    expect(state.phase).toBe("active");
    expect(state.endSince).toBeNull();
  });

  it("restarts the grace after each recovery", () => {
    const base = CONFIRM_S;
    const steps = [...hold(NONE, base + 1, base + GRACE_S - 1), ...hold(CALL, base + GRACE_S, base + GRACE_S + 1), ...hold(NONE, base + GRACE_S + 2, base + GRACE_S + 2 + GRACE_S - 1)];
    expect(run(steps, started().state).effects).toEqual([]);
  });

  it("does not end when the call window closes while a meeting app still holds the mic", () => {
    const { effects, state } = run(hold(WINDOW_CLOSED, CONFIRM_S + 1, CONFIRM_S + GRACE_S * 3), started().state);
    expect(effects).toEqual([]);
    expect(state.phase).toBe("active");
  });

  it("ends when the window closes and then the mic is released too", () => {
    const base = CONFIRM_S;
    const steps = [...hold(WINDOW_CLOSED, base + 1, base + 100), ...hold(NONE, base + 101, base + 101 + GRACE_S)];
    expect(run(steps, started().state).effects).toEqual([{ at: base + 101 + GRACE_S, effect: "stop" }]);
  });

  it("emits stop exactly once per meeting, then can start the next meeting", () => {
    const steps: Array<[number, AutoSignals]> = [
      ...hold(CALL, 0, 20),
      ...hold(NONE, 21, 21 + GRACE_S + 30),
      ...hold({ ...CALL, identity: "standup" }, 200, 220),
      ...hold(NONE, 221, 221 + GRACE_S + 30),
    ];
    expect(run(steps).effects.map((item) => item.effect)).toEqual(["start", "stop", "start", "stop"]);
  });
});

describe("max duration safety net", () => {
  const MAX_S = MAX_MEETING_MS / 1000;
  const longCall = () => {
    const active = run(hold(CALL, 0, CONFIRM_S)).state;
    // The call never ends: the window lingers and the mic stays held.
    return { active, steps: [[MAX_S - 1, CALL], [CONFIRM_S + MAX_S, CALL]] as Array<[number, AutoSignals]> };
  };

  it("keeps the length to a few hours", () => {
    expect(MAX_MEETING_MS).toBeGreaterThanOrEqual(3 * 3_600_000);
    expect(MAX_MEETING_MS).toBeLessThanOrEqual(4 * 3_600_000);
  });

  it("stops a meeting that never ends, once, and does not restart the same meeting", () => {
    const { active, steps } = longCall();
    const out = run([...steps, ...hold(CALL, CONFIRM_S + MAX_S + 1, CONFIRM_S + MAX_S + 120)], active);
    expect(out.effects).toEqual([{ at: CONFIRM_S + MAX_S, effect: "stop" }]);
    expect(out.state.phase).toBe("idle");
    expect(out.state.suppressed).not.toBeNull();
  });

  it("starts a different meeting after the max stop", () => {
    const { active, steps } = longCall();
    const next = { ...CALL, identity: "standup" };
    const out = run([...steps, ...hold(next, CONFIRM_S + MAX_S + 1, CONFIRM_S + MAX_S + 40)], active);
    expect(out.effects.map((item) => item.effect)).toEqual(["stop", "start"]);
  });

  it("starts the same meeting again once it has been clearly over", () => {
    const { active, steps } = longCall();
    const after = CONFIRM_S + MAX_S;
    const out = run([...steps, ...hold(NONE, after + 1, after + 1 + GRACE_S + 1), ...hold(CALL, after + 500, after + 500 + CONFIRM_S + 2)], active);
    expect(out.effects).toEqual([{ at: after, effect: "stop" }, { at: after + 500 + CONFIRM_S, effect: "start" }]);
  });

  it("keeps the suppression through a short gap", () => {
    const { active, steps } = longCall();
    const after = CONFIRM_S + MAX_S;
    const out = run([...steps, ...hold(NONE, after + 1, after + 10), ...hold(CALL, after + 11, after + 120)], active);
    expect(out.effects).toEqual([{ at: after, effect: "stop" }]);
  });
});

describe("setting changes", () => {
  it("forgets an active session when switched off, with no stop effect", () => {
    const active = run(hold(CALL, 0, CONFIRM_S)).state;
    const out = run([[CONFIRM_S + 1, CALL, { enabled: false }], ...hold(NONE, CONFIRM_S + 2, CONFIRM_S + 200)], active);
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual(IDLE_AUTO);
  });
});
