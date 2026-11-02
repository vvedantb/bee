// Mic hints: calm, local suggestions when the mic is silent, quiet or too loud, or when speech-to-text keeps hearing no words.
// Worked out from frame levels and phrase outcomes only: no audio is kept, no words are read, no AI is called. No window or React
// here, so tests drive it with synthetic levels (hints.test.ts) and store.ts feeds it real frames.
//
// How a hint shows:
// - Its condition holds without a break for HINT_SUSTAIN_MS (NO_INPUT_MS for no input). Frames further apart than FRAME_GAP_MS
//   break every condition: time with no frames is not evidence.
// - One hint at a time. When several are due, the first in HINT_IDS wins. A hint on screen is never replaced by another.
// - It hides after HINT_SHOW_MS, when dismissed, or when the mic turns off. "No input" also hides once speech is heard, and
//   "noisy" once a phrase comes back with words.
// - Once hidden, the same hint waits HINT_COOLDOWN_MS, and any hint waits HINT_SPACING_MS, before one shows again.
// - The mic being on is the only meeting gate. Waiting for meeting lines would hide "no input", which matters most before the first line.
//
// The thresholds are first guesses, not tuned on real hardware (like SPEECH_RMS).
import { SPEECH_RMS } from "./speech";

/** Every hint, highest priority first. With no input nothing else can work; quiet speech loses words; loud speech mostly still transcribes. */
export const HINT_IDS = ["no-input", "quiet", "clipping", "noisy"] as const;
export type HintId = (typeof HINT_IDS)[number];

export const HINT_TEXT: Record<HintId, string> = {
  "no-input": "No mic input detected. Check that the right microphone is selected and is not muted.",
  quiet: "Your voice is quiet. Try moving closer to the mic.",
  clipping: "Your mic is too loud. Move farther away or lower the input gain.",
  noisy: "Bee hears sound but no clear words. A quieter room or a headset may help.",
};

/**
 * A frame under this RMS (about −80 dBFS, a few steps of 16-bit audio) is no input: what a muted, unplugged or wrong mic sends.
 * Set this low so a quiet room, with noise suppression on, is less likely to count while the user just listens.
 */
export const NO_INPUT_RMS = 0.0001;
/** No input for this long, without a break, shows "no input". Longer than the others: the user may simply be listening. */
export const NO_INPUT_MS = 25_000;
/** While the user talks, a smoothed voice level under this RMS (about −30 dBFS) is quiet. Speech starts at SPEECH_RMS (0.01). */
export const QUIET_RMS = 0.03;
/** While the user talks, a smoothed voice level at or above this RMS (about −12 dBFS) is too loud: the notch meter (level × 4) is pegged. */
export const CLIPPING_RMS = 0.25;
/** A frame whose largest sample reaches this is clipped. */
export const CLIPPING_PEAK = 0.98;
/** A clipped frame keeps "too loud" going this long, so clipping on each stressed syllable reads as one stretch. */
export const CLIP_HOLD_MS = 1000;
/** Voiced frames closer together than this are one stretch of talk. A longer pause ends it, and its level is forgotten. */
export const TALK_GAP_MS = 2000;
/** Time constant of the voice level smoothing, so one loud syllable or one soft word does not flip quiet or too loud. */
export const LEVEL_SMOOTH_MS = 300;
/** Quiet or too loud must hold this long, without a break, before its hint shows. */
export const HINT_SUSTAIN_MS = 5000;
/**
 * This many phrases with no words, with none with words between them and all inside NOISY_WINDOW_MS, show "noisy". Each phrase
 * already had at least 300 ms of speech-level sound (speech.ts MIN_SPEECH_MS), so together they take longer than HINT_SUSTAIN_MS.
 */
export const NOISY_EMPTY_PHRASES = 4;
export const NOISY_WINDOW_MS = 60_000;
/** A hint hides by itself after this long. */
export const HINT_SHOW_MS = 15_000;
/** Once a hint hides (timed out, dismissed or mic off), it cannot show again for this long. */
export const HINT_COOLDOWN_MS = 4 * 60_000;
/** After any hint hides, no hint shows for this long, so hints never follow each other closely. */
export const HINT_SPACING_MS = 30_000;
/** Frames further apart than this (the window slept) break every condition. Frames normally come every ~85 ms (mic.ts). */
export const FRAME_GAP_MS = 1000;

export type Hint = { id: HintId; text: string; shownAt: number };

/** One mic frame, as numbers only. */
export type HintSample = {
  /** In ms, on the same clock as the detector's `now` option. */
  now: number;
  /** The frame's RMS (speech.ts frameLevel), 0 to 1. */
  level: number;
  /** The frame's largest absolute sample (speech.ts framePeak), 0 to 1, when known. */
  peak?: number;
  /** Mic capture is on. Off hides any hint and forgets what was heard, as clear() does. */
  micOn: boolean;
};

export type HintDetector = ReturnType<typeof createHintDetector>;

/**
 * The hint state machine. push() takes each mic frame and phrase() each phrase's speech-to-text outcome; both return the hint to
 * show now, or null. `now` is the clock for dismiss() and current() (Date.now by default); samples carry their own time.
 */
export function createHintDetector(options: { enabled: boolean; now?: () => number }) {
  const clock = options.now ?? Date.now;
  let enabled = options.enabled;
  let shown: Hint | null = null;
  // When each hint last hid, and when any did.
  const hiddenAt = new Map<HintId, number>();
  let lastHiddenAt = Number.NEGATIVE_INFINITY;
  // Between a push with the mic on and clear(). Phrase outcomes outside it are ignored: a phrase can settle after the mic is off.
  let listening = false;
  // What was heard. lastFrameAt: the latest frame. silentSince: the first of the frames under NO_INPUT_RMS in a row. voice: the
  // smoothed level of the current stretch of talk. quietSince and loudSince: when each condition began holding.
  let lastFrameAt: number | null = null;
  let silentSince: number | null = null;
  let lastVoicedAt: number | null = null;
  let voice: number | null = null;
  let lastClipAt: number | null = null;
  let quietSince: number | null = null;
  let loudSince: number | null = null;
  // When each phrase with no words since the last phrase with words came back.
  let emptyPhrases: number[] = [];

  function forgetLevels(): void {
    lastFrameAt = silentSince = lastVoicedAt = voice = lastClipAt = quietSince = loudSince = null;
  }

  function hide(now: number): void {
    if (!shown) return;
    hiddenAt.set(shown.id, now);
    lastHiddenAt = now;
    shown = null;
  }

  function stop(now: number): void {
    hide(now);
    forgetLevels();
    emptyPhrases = [];
    listening = false;
  }

  const held = (since: number | null, now: number, ms: number) => since !== null && now - since >= ms;

  function due(id: HintId, now: number): boolean {
    if (now - (hiddenAt.get(id) ?? Number.NEGATIVE_INFINITY) < HINT_COOLDOWN_MS) return false;
    if (id === "no-input") return held(silentSince, now, NO_INPUT_MS);
    if (id === "quiet") return held(quietSince, now, HINT_SUSTAIN_MS);
    if (id === "clipping") return held(loudSince, now, HINT_SUSTAIN_MS);
    return emptyPhrases.filter((at) => now - at < NOISY_WINDOW_MS).length >= NOISY_EMPTY_PHRASES;
  }

  /** Hides a hint that has had its time, then shows the first one due, if any. */
  function settle(now: number): Hint | null {
    if (shown && now - shown.shownAt >= HINT_SHOW_MS) hide(now);
    if (shown || now - lastHiddenAt < HINT_SPACING_MS) return shown;
    const id = HINT_IDS.find((candidate) => due(candidate, now));
    if (id) shown = { id, text: HINT_TEXT[id], shownAt: now };
    return shown;
  }

  return {
    push(sample: HintSample): Hint | null {
      if (!enabled) return null;
      const { now, level } = sample;
      if (!sample.micOn) {
        stop(now);
        return null;
      }
      listening = true;
      if (lastFrameAt !== null && (now < lastFrameAt || now - lastFrameAt > FRAME_GAP_MS)) forgetLevels();
      const step = lastFrameAt === null ? 0 : now - lastFrameAt;
      lastFrameAt = now;
      silentSince = level < NO_INPUT_RMS ? (silentSince ?? now) : null;
      // SPEECH_RMS is read here, not at load: the store tests mock speech.ts without it.
      if (level >= SPEECH_RMS) {
        // A new stretch of talk starts from this frame's level; within one, the level is smoothed by frame length.
        if (voice === null || lastVoicedAt === null || now - lastVoicedAt >= TALK_GAP_MS) voice = level;
        else voice += (1 - Math.exp(-step / LEVEL_SMOOTH_MS)) * (level - voice);
        lastVoicedAt = now;
        // Speech is input: "no input" is over.
        if (shown?.id === "no-input") hide(now);
      }
      if ((sample.peak ?? 0) >= CLIPPING_PEAK) lastClipAt = now;
      const talking = lastVoicedAt !== null && now - lastVoicedAt < TALK_GAP_MS;
      if (!talking) voice = null;
      const clipping = lastClipAt !== null && now - lastClipAt < CLIP_HOLD_MS;
      const quiet = talking && voice !== null && voice < QUIET_RMS && !clipping;
      const loud = talking && ((voice ?? 0) >= CLIPPING_RMS || clipping);
      quietSince = quiet ? (quietSince ?? now) : null;
      loudSince = loud ? (loudSince ?? now) : null;
      return settle(now);
    },

    /** A phrase's speech-to-text is done: words came back, or none did. Failed calls are not reported. Counts only, never words. */
    phrase(outcome: { now: number; words: boolean }): Hint | null {
      if (!enabled || !listening) return shown;
      const { now } = outcome;
      if (outcome.words) {
        emptyPhrases = [];
        if (shown?.id === "noisy") hide(now);
      } else {
        emptyPhrases = [...emptyPhrases.filter((at) => now - at < NOISY_WINDOW_MS), now];
      }
      return settle(now);
    },

    /** The hint on screen, or null. One that has had HINT_SHOW_MS hides first. */
    current(): Hint | null {
      if (shown && clock() - shown.shownAt >= HINT_SHOW_MS) hide(clock());
      return shown;
    },

    /** The user closed the hint (or the island under it). Given an id, only that hint closes. Its cooldown starts now. */
    dismiss(id?: HintId): void {
      if (shown && (id === undefined || shown.id === id)) hide(clock());
    },

    /** Mic off: hides any hint (its cooldown starts) and forgets what was heard. Cooldowns outlast it. */
    clear(): void {
      stop(clock());
    },

    /** The setting. Off hides any hint, as clear() does, and ignores frames and phrases until it is on again. */
    setEnabled(next: boolean): void {
      if (enabled && !next) stop(clock());
      enabled = next;
    },
  };
}
