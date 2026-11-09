import { describe, expect, it } from "vitest";
import {
  CONFIRM_CALENDAR_MS,
  CONFIRM_MS,
  END_GRACE_MS,
  IDLE_AUTO,
  MAX_MEETING_MS,
  qualifies,
  stepAutoMeeting,
  type AutoEvent,
  type AutoMeetingState,
  type AutoSignals,
} from "./auto-meeting-detection";

const NONE: AutoSignals = { meetingAppPresent: false, inCallTitle: false };
const CALL: AutoSignals = { meetingAppPresent: true, inCallTitle: true, micInUseByMeetingApp: true, identity: "weekly sync" };
const CHAT: AutoSignals = { meetingAppPresent: true, inCallTitle: false, micInUseByMeetingApp: false };
const WINDOW_CLOSED: AutoSignals = { meetingAppPresent: true, inCallTitle: false, micInUseByMeetingApp: true, identity: "weekly sync" };

// Runs the machine over (seconds, signals) steps. Effects are collected with the time they fired.
function run(steps: Array<[number, AutoSignals, { enabled?: boolean; event?: AutoEvent }?]>, from: AutoMeetingState = IDLE_AUTO) {
  let state = from;
  const effects: Array<{ at: number; effect: string }> = [];
  for (const [seconds, signals, options] of steps) {
    const out = stepAutoMeeting(state, { signals, enabled: options?.enabled ?? true, now: seconds * 1000, event: options?.event });
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

const OFF = { enabled: false };
const holdOff = (signals: AutoSignals, from: number, upTo: number): Array<[number, AutoSignals, { enabled: boolean }]> =>
  hold(signals, from, upTo).map(([s, sig]) => [s, sig, OFF]);

describe("auto-confirm on", () => {
  it("starts with no prompt effect", () => {
    const { effects } = run(hold(CALL, 0, 60));
    expect(effects).toEqual([{ at: CONFIRM_S, effect: "start" }]);
  });
});

describe("auto-confirm off: prompt", () => {
  const prompted = () => run(holdOff(CALL, 0, CONFIRM_S));

  it("prompts after the confirm time and starts nothing", () => {
    const { effects, state } = run(holdOff(CALL, 0, CONFIRM_S + 60));
    expect(effects).toEqual([{ at: CONFIRM_S, effect: "prompt" }]);
    expect(state.phase).toBe("prompted");
    expect(state.startedAt).toBeNull();
  });

  it("uses the calendar-shortened confirm time", () => {
    expect(run(holdOff({ ...CALL, calendarBoost: true }, 0, 20)).effects).toEqual([{ at: CONFIRM_CALENDAR_MS / 1000, effect: "prompt" }]);
  });

  it("never prompts for chat only", () => {
    expect(run(holdOff(CHAT, 0, 120)).effects).toEqual([]);
  });

  it("accept starts the meeting once and makes it active", () => {
    const out = run([[CONFIRM_S + 2, CALL, { enabled: false, event: "accept" }], ...holdOff(CALL, CONFIRM_S + 3, CONFIRM_S + 60)], prompted().state);
    expect(out.effects).toEqual([{ at: CONFIRM_S + 2, effect: "start" }]);
    expect(out.state.phase).toBe("active");
    expect(out.state.startedAt).toBe((CONFIRM_S + 2) * 1000);
  });

  it("accept does nothing when no prompt is waiting", () => {
    expect(run([[1, CALL, { enabled: false, event: "accept" }]]).effects).toEqual([]);
  });

  it("dismisses an ignored prompt, quietly, once the call has been over for the grace", () => {
    const base = CONFIRM_S;
    const out = run(holdOff(NONE, base + 1, base + 1 + GRACE_S + 30), prompted().state);
    expect(out.effects).toEqual([{ at: base + 1 + GRACE_S, effect: "dismiss" }]);
    expect(out.state.phase).toBe("idle");
  });

  it("keeps the prompt through a short drop", () => {
    const base = CONFIRM_S;
    const out = run([...holdOff(NONE, base + 1, base + 10), ...holdOff(CALL, base + 11, base + 100)], prompted().state);
    expect(out.effects).toEqual([]);
    expect(out.state.phase).toBe("prompted");
  });

  it("prompts again for the next meeting after a dismiss", () => {
    const out = run([...holdOff(CALL, 0, 20), ...holdOff(NONE, 21, 21 + GRACE_S + 5), ...holdOff({ ...CALL, identity: "standup" }, 200, 220)]);
    expect(out.effects.map((item) => item.effect)).toEqual(["prompt", "dismiss", "prompt"]);
  });

  it("reject on a prompt dismisses it and does not prompt the same meeting again", () => {
    const out = run([[CONFIRM_S + 1, CALL, { enabled: false, event: "reject" }], ...holdOff(CALL, CONFIRM_S + 2, CONFIRM_S + 120)], prompted().state);
    expect(out.effects).toEqual([{ at: CONFIRM_S + 1, effect: "dismiss" }]);
  });

  it("turning auto-confirm on accepts a waiting prompt", () => {
    const out = run([[CONFIRM_S + 5, CALL]], prompted().state);
    expect(out.effects).toEqual([{ at: CONFIRM_S + 5, effect: "start" }]);
  });
});

describe("auto-confirm off: active meeting", () => {
  const active = () => run([...holdOff(CALL, 0, CONFIRM_S), [CONFIRM_S + 1, CALL, { enabled: false, event: "accept" }]]);

  it("auto-stops after the end grace, as with auto-confirm on", () => {
    const base = CONFIRM_S + 1;
    const out = run(holdOff(NONE, base + 1, base + 1 + GRACE_S + 10), active().state);
    expect(out.effects).toEqual([{ at: base + 1 + GRACE_S, effect: "stop" }]);
    expect(out.state.phase).toBe("idle");
  });

  it("stops on the user's stop and suppresses the same meeting", () => {
    const base = CONFIRM_S + 1;
    const out = run([[base + 5, CALL, { enabled: false, event: "reject" }], ...holdOff(CALL, base + 6, base + 200)], active().state);
    expect(out.effects).toEqual([{ at: base + 5, effect: "stop" }]);
    expect(out.state.phase).toBe("idle");
    expect(out.state.suppressed).not.toBeNull();
  });

  it("prompts again once the stopped meeting has been over for the grace", () => {
    const base = CONFIRM_S + 1;
    const out = run(
      [[base + 5, CALL, { enabled: false, event: "reject" }], ...holdOff(NONE, base + 6, base + 6 + GRACE_S + 1), ...holdOff(CALL, base + 500, base + 500 + CONFIRM_S + 1)],
      active().state,
    );
    expect(out.effects.map((item) => item.effect)).toEqual(["stop", "prompt"]);
  });

  it("prompts for a different meeting straight after a stop", () => {
    const base = CONFIRM_S + 1;
    const next = { ...CALL, identity: "standup" };
    const out = run([[base + 5, CALL, { enabled: false, event: "reject" }], ...holdOff(next, base + 6, base + 6 + CONFIRM_S + 1)], active().state);
    expect(out.effects.map((item) => item.effect)).toEqual(["stop", "prompt"]);
  });

  it("applies the maximum length", () => {
    const base = CONFIRM_S + 1;
    const out = run([[base + MAX_MEETING_MS / 1000, CALL, OFF], ...holdOff(CALL, base + MAX_MEETING_MS / 1000 + 1, base + MAX_MEETING_MS / 1000 + 100)], active().state);
    expect(out.effects).toEqual([{ at: base + MAX_MEETING_MS / 1000, effect: "stop" }]);
  });
});

describe("setting changes", () => {
  it("keeps an active meeting when auto-confirm is switched off: the notes are not lost", () => {
    const active = run(hold(CALL, 0, CONFIRM_S)).state;
    const out = run([...holdOff(CALL, CONFIRM_S + 1, CONFIRM_S + 50), ...holdOff(NONE, CONFIRM_S + 51, CONFIRM_S + 51 + GRACE_S)], active);
    expect(out.effects).toEqual([{ at: CONFIRM_S + 51 + GRACE_S, effect: "stop" }]);
  });
});

describe("pre-join (new Teams lobby)", () => {
  const PRE: AutoSignals = { meetingAppPresent: true, inCallTitle: false, preJoinTitle: true, micInUseByMeetingApp: false, identity: null };
  // In the call, mic muted: the in-call title alone qualifies.
  const MUTED_CALL: AutoSignals = { meetingAppPresent: true, inCallTitle: true, preJoinTitle: false, micInUseByMeetingApp: false, identity: "weekly sync" };
  const off = holdOff;

  it("pre-join alone does not qualify", () => {
    expect(qualifies(PRE)).toBe(false);
  });

  it("auto on: one ready effect at once, and nothing records while only pre-join shows", () => {
    const { effects, state } = run(hold(PRE, 0, 600));
    expect(effects).toEqual([{ at: 0, effect: "ready" }]);
    expect(state.phase).toBe("ready");
    expect(state.startedAt).toBeNull();
  });

  it("auto on: starts only once the in-call title holds for the confirm time (muted, no mic)", () => {
    const { effects } = run([...hold(PRE, 0, 30), ...hold(MUTED_CALL, 31, 31 + CONFIRM_S + 2)]);
    expect(effects).toEqual([{ at: 0, effect: "ready" }, { at: 31 + CONFIRM_S, effect: "start" }]);
  });

  it("auto on: the mic alone also confirms the call", () => {
    const micCall: AutoSignals = { meetingAppPresent: true, inCallTitle: false, preJoinTitle: false, micInUseByMeetingApp: true, identity: null };
    const { effects } = run([...hold(PRE, 0, 5), ...hold(micCall, 6, 6 + CONFIRM_S + 1)]);
    expect(effects.map((entry) => entry.effect)).toEqual(["ready", "start"]);
  });

  it("auto on: leaving the lobby without joining clears it after the grace, once", () => {
    const { effects, state } = run([...hold(PRE, 0, 10), ...hold(NONE, 11, 11 + GRACE_S + 2)]);
    expect(effects).toEqual([{ at: 0, effect: "ready" }, { at: 11 + GRACE_S, effect: "dismiss" }]);
    expect(state.phase).toBe("idle");
  });

  it("auto on: a short title flicker in the lobby does not show Bee a second time", () => {
    const { effects } = run([...hold(PRE, 0, 5), ...hold(NONE, 6, 10), ...hold(PRE, 11, 20)]);
    expect(effects).toEqual([{ at: 0, effect: "ready" }]);
  });

  it("auto off: prompts at once on pre-join, once, and starts nothing", () => {
    const { effects, state } = run(off(PRE, 0, 600));
    expect(effects).toEqual([{ at: 0, effect: "prompt" }]);
    expect(state.phase).toBe("prompted");
    expect(state.startedAt).toBeNull();
  });

  it("auto off: the call confirming after pre-join does not prompt again; Start still starts it", () => {
    const { effects, state } = run([...off(PRE, 0, 10), ...off(MUTED_CALL, 11, 60)]);
    expect(effects).toEqual([{ at: 0, effect: "prompt" }]);
    expect(state.phase).toBe("prompted");
    const accepted = run([[61, MUTED_CALL, { enabled: false, event: "accept" }]], state);
    expect(accepted.effects).toEqual([{ at: 61, effect: "start" }]);
    expect(accepted.state.phase).toBe("active");
  });

  it("auto off: a muted call with no pre-join seen prompts after the confirm time", () => {
    expect(run(off(MUTED_CALL, 0, CONFIRM_S + 2)).effects).toEqual([{ at: CONFIRM_S, effect: "prompt" }]);
  });

  it("auto off: turning auto on while the lobby prompt waits does not start before the call", () => {
    const prompted = run(off(PRE, 0, 5)).state;
    expect(run(hold(PRE, 6, 60), prompted).effects).toEqual([]);
    expect(run(hold(MUTED_CALL, 6, 7), prompted).effects).toEqual([{ at: 6, effect: "start" }]);
  });

  it("auto off: a rejected lobby prompt is not offered again for the same join", () => {
    const prompted = run(off(PRE, 0, 5)).state;
    const rejected = run([[6, PRE, { enabled: false, event: "reject" }]], prompted);
    expect(rejected.effects).toEqual([{ at: 6, effect: "dismiss" }]);
    expect(run([...off(PRE, 7, 40), ...off(MUTED_CALL, 41, 80)], rejected.state).effects).toEqual([]);
  });

  it("chat-only Teams never shows or prompts", () => {
    expect(run(holdOff(CHAT, 0, 300)).effects).toEqual([]);
    expect(run(hold(CHAT, 0, 300)).effects).toEqual([]);
  });
});
