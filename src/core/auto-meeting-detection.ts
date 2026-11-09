// Automatic meeting detection, pure. Each tick takes the latest signals and returns the next state plus at most one effect:
// "prompt" (ask the user to start), "ready" (auto-confirm on, pre-join seen: show Bee, record nothing yet), "start" (mic on, meeting mode for the session), "stop" (save the summary, mic off) or
// "dismiss" (the prompt was ignored and the call ended). `enabled` means auto-confirm: on, a confirmed call starts by itself; off,
// it prompts and waits for the user's accept event. Detection always runs. No OS, Electron or IPC here;
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
  /** A pre-join window is open ("Meeting join | …" in new Teams). Not a call yet: Bee shows itself and may prompt, but records nothing. */
  preJoinTitle?: boolean;
  /** The title class behind the two flags above. Debug log only; the machine does not read it. */
  titleClass?: TitleClass;
  /** A meeting app holds the microphone now (OS probe). Undefined when the platform cannot say. */
  micInUseByMeetingApp?: boolean;
  /** Bee's own calendar data says a meeting is on now. Weak: shortens the confirmation only. */
  calendarBoost?: boolean;
  /** The meeting's own name or window key, when known. Tells one meeting from the next. */
  identity?: string | null;
};

/** prompted: with auto-confirm off, waiting for the user. Nothing records until they accept. ready: auto-confirm on, pre-join seen, waiting for the call itself. */
export type AutoPhase = "idle" | "confirming" | "prompted" | "ready" | "active";

/** What the Teams window titles say now, for the debug log: none (no window), prejoin, incall, chat (tabs and chat only) or na (windows with no readable title). */
export type TitleClass = "none" | "prejoin" | "incall" | "chat" | "na";

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
  /** Set by the max-duration stop or a user stop/reject: this meeting does not start or prompt again. */
  suppressed: { identity: string | null } | null;
  /** When the signal last went quiet while suppressed. Enough quiet clears the suppression. */
  quietSince: number | null;
};

export type AutoEffect = "prompt" | "ready" | "start" | "stop" | "dismiss" | "none";

/** The user's answer from a toast button: accept starts a prompted meeting; reject stops an active one (or declines a prompt). */
export type AutoEvent = "accept" | "reject";

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
  input: { signals: AutoSignals; enabled: boolean; now: number; event?: AutoEvent },
): { state: AutoMeetingState; effect: AutoEffect } {
  const { signals, enabled, now, event } = input;
  const qualifying = qualifies(signals);
  // Pre-join only: the app is open on its join screen and nothing says the call has begun.
  const preJoin = !qualifying && signals.meetingAppPresent && signals.preJoinTitle === true;
  const present = qualifying || preJoin;
  const identity = signals.identity ?? null;

  // The user's answer comes first. A reject is a quiet no: the same meeting is not offered again.
  if (event === "reject" && (state.phase === "active" || state.phase === "prompted")) {
    return { state: { ...IDLE_AUTO, suppressed: { identity: identity ?? state.identity }, quietSince: null }, effect: state.phase === "active" ? "stop" : "dismiss" };
  }
  if (event === "accept" && state.phase === "prompted") {
    return { state: { ...IDLE_AUTO, phase: "active", startedAt: now, identity: identity ?? state.identity }, effect: "start" };
  }

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

  // Prompted: the call going away for the full grace dismisses the prompt. Nothing was recorded, so nothing is saved.
  if (state.phase === "prompted") {
    // Turning auto-confirm on while a prompt waits accepts it, once the call itself is on (not on the pre-join screen).
    if (qualifying && enabled) return { state: { ...IDLE_AUTO, phase: "active", startedAt: now, identity: identity ?? state.identity }, effect: "start" };
    if (present) return { state: { ...state, endSince: null, identity: identity ?? state.identity }, effect: "none" };
    const endSince = state.endSince ?? now;
    if (now - endSince >= END_GRACE_MS) return { state: { ...IDLE_AUTO, quietSince: now }, effect: "dismiss" };
    return { state: { ...state, endSince }, effect: "none" };
  }

  // Ready (pre-join seen, auto-confirm on): leaving the join screen without a call for the full grace clears it.
  if (state.phase === "ready" && !present) {
    const endSince = state.endSince ?? now;
    if (now - endSince >= END_GRACE_MS) return { state: { ...IDLE_AUTO, quietSince: now }, effect: "dismiss" };
    return { state: { ...state, endSince }, effect: "none" };
  }

  // Suppressed (max-duration stop, or the user said no): stays quiet until the meeting is clearly over or a different one starts.
  let suppressed = state.suppressed;
  let quietSince = state.quietSince;
  if (suppressed) {
    if (qualifying && !sameMeeting(suppressed.identity, identity)) suppressed = null;
    else if (present) quietSince = null;
    else {
      quietSince ??= now;
      if (now - quietSince >= END_GRACE_MS) suppressed = null;
    }
    if (suppressed) return { state: { ...state, suppressed, quietSince, phase: "idle", qualSince: null }, effect: "none" };
    quietSince = null;
  }

  if (!present) return { state: { ...IDLE_AUTO, suppressed, quietSince }, effect: "none" };
  // Pre-join only: show Bee once. Auto-confirm off offers Start (recording still waits for the click); on, Bee gets ready and
  // records nothing until the call itself shows (mic or an in-call title).
  if (!qualifying) {
    if (state.phase === "ready") return { state: { ...state, endSince: null }, effect: "none" };
    if (enabled) return { state: { ...IDLE_AUTO, phase: "ready", identity }, effect: "ready" };
    return { state: { ...IDLE_AUTO, phase: "prompted", identity }, effect: "prompt" };
  }
  // A different meeting appearing mid-confirmation restarts the count.
  const qualSince = state.phase === "confirming" && state.qualSince !== null && sameMeeting(state.identity, identity) ? state.qualSince : now;
  const confirmMs = signals.calendarBoost ? CONFIRM_CALENDAR_MS : CONFIRM_MS;
  if (now - qualSince >= confirmMs) {
    if (enabled) return { state: { ...IDLE_AUTO, phase: "active", startedAt: now, identity }, effect: "start" };
    return { state: { ...IDLE_AUTO, phase: "prompted", identity }, effect: "prompt" };
  }
  return { state: { ...IDLE_AUTO, phase: "confirming", qualSince, identity }, effect: "none" };
}
