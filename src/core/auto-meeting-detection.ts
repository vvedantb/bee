// Automatic meeting detection, pure. Each tick takes the latest signals and returns the next state plus at most one effect:
// "start" (mic on, meeting mode for the session) or "stop" (save the summary, mic off). This is the only way a meeting starts
// or stops: there is no manual start or stop. Setting off means no meetings. No OS, Electron or IPC here;
// main/meeting-signals.ts reads the signals and the renderer store applies the effects.

/** A call must qualify this long without a break before Bee starts. Long enough to skip a window flicker, short enough to catch the first words. */
export const CONFIRM_MS = 8_000;
/** A calendar event now makes a qualifying call confirm sooner. It never starts anything alone. */
export const CONFIRM_CALENDAR_MS = 5_000;
/** The end condition must hold this long before Bee stops and saves. Covers a mic drop, a muted call or a pop-out window closing. */
export const END_GRACE_MS = 45_000;
/**
 * Safety net, not UI: a meeting that runs this long is stopped and saved, even if a window lingers or the OS still reports the
 * mic in use. The same meeting does not start again until the signal has been quiet for END_GRACE_MS or a different one begins.
 */
export const MAX_MEETING_MS = 4 * 60 * 60_000;

export type AutoSignals = {
  /** Teams (new or classic), Zoom, or a Google Meet window is open. A browser alone does not count. */
  meetingAppPresent: boolean;
  /** A meeting window title reads like a live call (not chat, home or calendar). */
  inCallTitle: boolean;
  /** A meeting app holds the microphone now (OS probe). Undefined when the platform cannot say. */
  micInUseByMeetingApp?: boolean;
  /** Bee's own calendar data says a meeting is on now. Weak: shortens the confirmation only. */
  calendarBoost?: boolean;
  /** The meeting's own name or window key, when known. Tells one meeting from the next. */
  identity?: string | null;
};

export type AutoPhase = "idle" | "confirming" | "active";

export type AutoMeetingState = {
  phase: AutoPhase;
  /** When the current run of qualifying signal began (confirming). */
  qualSince: number | null;
  /** When the end condition began (active). */
  endSince: number | null;
  /** When the active session started, for MAX_MEETING_MS. */
  startedAt: number | null;
  /** The meeting identity of the session or confirmation. */
  identity: string | null;
  /** Set by the max-duration stop: this meeting does not auto-start again. */
  suppressed: { identity: string | null } | null;
  /** When the signal last went quiet while suppressed. Enough quiet clears the suppression. */
  quietSince: number | null;
};

export type AutoEffect = "start" | "stop" | "none";

export const IDLE_AUTO: AutoMeetingState = { phase: "idle", qualSince: null, endSince: null, startedAt: null, identity: null, suppressed: null, quietSince: null };

/** Meeting app AND (mic held by it OR an in-call title). Calendar never counts here. */
export function qualifies(signals: AutoSignals): boolean {
  return signals.meetingAppPresent && (signals.micInUseByMeetingApp === true || signals.inCallTitle);
}

// Two known, different identities are different meetings. An unknown one cannot be told apart, so it counts as the same.
function sameMeeting(a: string | null, b: string | null): boolean {
  return a === null || b === null || a === b;
}

export function stepAutoMeeting(
  state: AutoMeetingState,
  input: { signals: AutoSignals; enabled: boolean; now: number },
): { state: AutoMeetingState; effect: AutoEffect } {
  const { signals, enabled, now } = input;
  const qualifying = qualifies(signals);
  const identity = signals.identity ?? null;

  // Off: no meetings. Forget any session without touching the mic or the summary.
  if (!enabled) return { state: state.phase === "idle" && !state.suppressed ? state : IDLE_AUTO, effect: "none" };

  if (state.phase === "active") {
    const startedAt = state.startedAt ?? now;
    // Safety net: stop a runaway meeting and keep this one from starting again by itself.
    if (now - startedAt >= MAX_MEETING_MS) {
      return { state: { ...IDLE_AUTO, suppressed: { identity: identity ?? state.identity }, quietSince: null }, effect: "stop" };
    }
    if (qualifying) return { state: { ...state, startedAt, endSince: null, identity: identity ?? state.identity }, effect: "none" };
    const endSince = state.endSince ?? now;
    if (now - endSince >= END_GRACE_MS) return { state: { ...IDLE_AUTO, quietSince: now }, effect: "stop" };
    return { state: { ...state, startedAt, endSince }, effect: "none" };
  }

  // Suppressed by the max-duration stop: stays off until the meeting is clearly over or a different one starts.
  let suppressed = state.suppressed;
  let quietSince = state.quietSince;
  if (suppressed) {
    if (qualifying && !sameMeeting(suppressed.identity, identity)) suppressed = null;
    else if (qualifying) quietSince = null;
    else {
      quietSince ??= now;
      if (now - quietSince >= END_GRACE_MS) suppressed = null;
    }
    if (suppressed) return { state: { ...state, suppressed, quietSince, phase: "idle", qualSince: null }, effect: "none" };
    quietSince = null;
  }

  if (!qualifying) return { state: { ...IDLE_AUTO, suppressed, quietSince }, effect: "none" };
  // A different meeting appearing mid-confirmation restarts the count.
  const qualSince = state.phase === "confirming" && state.qualSince !== null && sameMeeting(state.identity, identity) ? state.qualSince : now;
  const confirmMs = signals.calendarBoost ? CONFIRM_CALENDAR_MS : CONFIRM_MS;
  if (now - qualSince >= confirmMs) {
    return { state: { ...IDLE_AUTO, phase: "active", startedAt: now, identity }, effect: "start" };
  }
  return { state: { ...IDLE_AUTO, phase: "confirming", qualSince, identity }, effect: "none" };
}
