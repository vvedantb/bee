import { describe, expect, it } from "vitest";
import {
  CLIPPING_RMS,
  FRAME_GAP_MS,
  HINT_COOLDOWN_MS,
  HINT_IDS,
  HINT_SHOW_MS,
  HINT_SPACING_MS,
  HINT_SUSTAIN_MS,
  HINT_TEXT,
  NOISY_EMPTY_PHRASES,
  NOISY_WINDOW_MS,
  NO_INPUT_MS,
  NO_INPUT_RMS,
  QUIET_RMS,
  createHintDetector,
  type HintId,
} from "./hints";
import { SPEECH_RMS } from "./speech";

// Synthetic levels only: no audio buffers and no words. Frames are ~85 ms, like 4096 samples at 48 kHz (mic.ts).
const FRAME_MS = 85;
const QUIET = (SPEECH_RMS + QUIET_RMS) / 2;
const NORMAL = 0.1;
const LOUD = 0.4;
const HISS = 0.0005;

function rig() {
  let now = 0;
  const detector = createHintDetector({ now: () => now });
  // Every hint id seen on screen, in order, each time it appears.
  const seen: HintId[] = [];
  let last: HintId | null = null;
  const note = (id: HintId | null) => {
    if (id && id !== last) seen.push(id);
    last = id;
  };
  return {
    detector,
    seen,
    get now() {
      return now;
    },
    /** Frames at `level` (or by time, from a function) for `ms`. Returns the hint on screen after the last frame. */
    frames(ms: number, level: number | ((at: number) => number), extra: { peak?: number; micOn?: boolean } = {}) {
      const end = now + ms;
      let hint = detector.current();
      while (now < end) {
        now += FRAME_MS;
        hint = detector.push({ now, level: typeof level === "number" ? level : level(now), micOn: extra.micOn ?? true, ...(extra.peak === undefined ? {} : { peak: extra.peak }) });
        note(hint?.id ?? null);
      }
      return hint;
    },
    phrase(words: boolean) {
      const hint = detector.phrase({ now, words });
      note(hint?.id ?? null);
      return hint;
    },
    wait(ms: number) {
      now += ms;
    },
  };
}

/** Speech with pauses: 700 ms of voice, then 300 ms of room sound. */
const talking = (voice: number) => (at: number) => (at % 1000 < 700 ? voice : HISS);

describe("hint copy and constants", () => {
  it("has a calm line for every hint, highest priority first, with no model names", () => {
    expect(HINT_IDS).toEqual(["no-input", "quiet", "clipping", "noisy"]);
    expect(HINT_TEXT.quiet).toBe("Your voice is quiet. Try moving closer to the mic.");
    expect(HINT_TEXT.clipping).toBe("Your mic is too loud. Move farther away or lower the input gain.");
    expect(HINT_TEXT["no-input"]).toMatch(/^No mic input detected\. Check that the right microphone is selected/);
    for (const text of Object.values(HINT_TEXT)) {
      expect(text).not.toMatch(/grok|claude|luna|jev|clerk|error|!/i);
      expect(text.length).toBeLessThan(100);
    }
  });

  it("keeps quiet between the speech floor and the loud ceiling, and no input far below speech", () => {
    expect(NO_INPUT_RMS).toBeLessThan(SPEECH_RMS);
    expect(SPEECH_RMS).toBeLessThan(QUIET_RMS);
    expect(QUIET_RMS).toBeLessThan(CLIPPING_RMS);
  });
});

describe("quiet", () => {
  it("shows only after the user has talked quietly for the sustain time", () => {
    const t = rig();
    expect(t.frames(HINT_SUSTAIN_MS - 500, QUIET)).toBeNull();
    expect(t.frames(600, QUIET)).toMatchObject({ id: "quiet", text: HINT_TEXT.quiet });
  });

  it("holds through the pauses between words", () => {
    const t = rig();
    expect(t.frames(HINT_SUSTAIN_MS - 500, talking(QUIET))).toBeNull();
    expect(t.frames(1000, talking(QUIET))?.id).toBe("quiet");
  });

  it("starts over after a long pause, so two short quiet stretches do not add up", () => {
    const t = rig();
    t.frames(3000, QUIET);
    t.frames(3000, HISS);
    expect(t.frames(3000, QUIET)).toBeNull();
  });

  it("never shows for a normal voice, room sound alone, or one soft word in normal speech", () => {
    const t = rig();
    t.frames(60_000, talking(NORMAL));
    t.frames(60_000, HISS);
    t.frames(60_000, (at) => (at % 3000 < 200 ? QUIET : NORMAL));
    expect(t.seen).toEqual([]);
  });
});

describe("no input", () => {
  it("shows only after the mic has sent near silence for NO_INPUT_MS", () => {
    const t = rig();
    expect(t.frames(NO_INPUT_MS - 500, 0)).toBeNull();
    expect(t.frames(600, 0)?.id).toBe("no-input");
  });

  it("starts over on any sound above the floor", () => {
    const t = rig();
    t.frames(NO_INPUT_MS - 1000, 0);
    t.frames(FRAME_MS, HISS);
    expect(t.frames(NO_INPUT_MS - 1000, 0)).toBeNull();
  });

  it("does not count a quiet room while the user listens", () => {
    const t = rig();
    expect(t.frames(5 * 60_000, HISS)).toBeNull();
  });

  it("hides as soon as speech is heard", () => {
    const t = rig();
    expect(t.frames(NO_INPUT_MS + 100, 0)?.id).toBe("no-input");
    expect(t.frames(FRAME_MS, NORMAL)).toBeNull();
  });
});

describe("clipping", () => {
  it("shows only after loud speech holds for the sustain time", () => {
    const t = rig();
    expect(t.frames(HINT_SUSTAIN_MS - 500, talking(LOUD))).toBeNull();
    expect(t.frames(1000, talking(LOUD))?.id).toBe("clipping");
  });

  it("shows for clipped peaks on each syllable, even at a normal level", () => {
    const t = rig();
    const peaks = (ms: number) => {
      let hint = null;
      for (let at = 0; at < ms; at += 500) {
        hint = t.frames(FRAME_MS, NORMAL, { peak: 1 });
        hint = t.frames(500 - FRAME_MS, NORMAL, { peak: 0.5 });
      }
      return hint;
    };
    expect(peaks(HINT_SUSTAIN_MS - 1000)).toBeNull();
    expect(peaks(1500)?.id).toBe("clipping");
  });

  it("does not show for one loud burst", () => {
    const t = rig();
    t.frames(1000, LOUD);
    expect(t.frames(30_000, talking(NORMAL))).toBeNull();
  });
});

describe("noisy", () => {
  it("shows after several phrases in a row come back with no words", () => {
    const t = rig();
    t.frames(1000, HISS);
    for (let index = 1; index < NOISY_EMPTY_PHRASES; index += 1) {
      expect(t.phrase(false)).toBeNull();
      t.frames(2000, HISS);
    }
    expect(t.phrase(false)).toMatchObject({ id: "noisy", text: HINT_TEXT.noisy });
  });

  it("starts over on a phrase with words, and forgets phrases outside the window", () => {
    const t = rig();
    t.frames(1000, HISS);
    for (let index = 1; index < NOISY_EMPTY_PHRASES; index += 1) t.phrase(false);
    expect(t.phrase(true)).toBeNull();
    expect(t.phrase(false)).toBeNull();
    t.frames(NOISY_WINDOW_MS, HISS);
    for (let index = 1; index < NOISY_EMPTY_PHRASES; index += 1) expect(t.phrase(false)).toBeNull();
  });

  it("hides once a phrase comes back with words", () => {
    const t = rig();
    t.frames(1000, HISS);
    for (let index = 0; index < NOISY_EMPTY_PHRASES; index += 1) t.phrase(false);
    expect(t.detector.current()?.id).toBe("noisy");
    expect(t.phrase(true)).toBeNull();
  });

  it("ignores phrases that settle after the mic is off", () => {
    const t = rig();
    t.frames(1000, HISS);
    t.frames(FRAME_MS, HISS, { micOn: false });
    for (let index = 0; index < NOISY_EMPTY_PHRASES; index += 1) expect(t.phrase(false)).toBeNull();
  });
});

describe("showing and hiding", () => {
  it("hides by itself after HINT_SHOW_MS", () => {
    const t = rig();
    t.frames(HINT_SUSTAIN_MS + 100, QUIET);
    expect(t.frames(HINT_SHOW_MS - 500, talking(NORMAL))?.id).toBe("quiet");
    expect(t.frames(600, talking(NORMAL))).toBeNull();
  });

  it("hides on current() once its time is up, with no frames coming", () => {
    const t = rig();
    t.frames(HINT_SUSTAIN_MS + 100, QUIET);
    t.wait(HINT_SHOW_MS);
    expect(t.detector.current()).toBeNull();
  });

  it("does not show the same hint again until its cooldown has passed", () => {
    const t = rig();
    t.frames(HINT_SUSTAIN_MS + 100, QUIET);
    t.detector.dismiss();
    expect(t.detector.current()).toBeNull();
    // Still quiet the whole time: nothing until the cooldown ends, then quiet again.
    expect(t.frames(HINT_COOLDOWN_MS - 1000, talking(QUIET))).toBeNull();
    expect(t.frames(2000, talking(QUIET))?.id).toBe("quiet");
    expect(t.seen).toEqual(["quiet", "quiet"]);
  });

  it("starts the cooldown when a hint times out, too", () => {
    const t = rig();
    t.frames(HINT_SUSTAIN_MS + 100, QUIET);
    t.frames(HINT_SHOW_MS + 100, QUIET);
    expect(t.frames(HINT_COOLDOWN_MS - 1000, QUIET)).toBeNull();
    expect(t.seen).toEqual(["quiet"]);
  });

  it("dismiss(id) leaves a different hint alone", () => {
    const t = rig();
    t.frames(HINT_SUSTAIN_MS + 100, QUIET);
    t.detector.dismiss("clipping");
    expect(t.detector.current()?.id).toBe("quiet");
  });

  it("shows one hint at a time and never replaces the one on screen", () => {
    const t = rig();
    t.frames(HINT_SUSTAIN_MS + 100, QUIET);
    // Clipping becomes due while quiet is still up.
    expect(t.frames(HINT_SUSTAIN_MS + 1000, LOUD)?.id).toBe("quiet");
    expect(t.seen).toEqual(["quiet"]);
  });

  it("waits HINT_SPACING_MS after any hint before the next, then shows the highest priority due", () => {
    const t = rig();
    t.frames(HINT_SUSTAIN_MS + 100, LOUD);
    expect(t.detector.current()?.id).toBe("clipping");
    t.detector.dismiss();
    // During the spacing: noisy becomes due (empty phrases), then no input (silence).
    for (let index = 0; index < NOISY_EMPTY_PHRASES; index += 1) expect(t.phrase(false)).toBeNull();
    expect(t.frames(HINT_SPACING_MS - 500, 0)).toBeNull();
    expect(t.frames(1000, 0)?.id).toBe("no-input");
    expect(t.seen).toEqual(["clipping", "no-input"]);
  });

  it("hides and forgets what was heard when the mic turns off; cooldowns stay", () => {
    const t = rig();
    t.frames(HINT_SUSTAIN_MS + 100, QUIET);
    expect(t.frames(FRAME_MS, QUIET, { micOn: false })).toBeNull();
    // Quiet again at once: on cooldown, so nothing.
    expect(t.frames(HINT_SUSTAIN_MS + 100, QUIET)).toBeNull();
    // Clipping is not on cooldown, but the mic toggled mid-way: its sustain starts over.
    t.wait(HINT_SPACING_MS);
    t.frames(3000, LOUD);
    t.detector.clear();
    expect(t.frames(3000, LOUD)).toBeNull();
    expect(t.frames(2500, LOUD)?.id).toBe("clipping");
  });

  it("breaks every condition when frames stop for a while", () => {
    const t = rig();
    t.frames(3000, QUIET);
    t.wait(FRAME_GAP_MS + 1000);
    expect(t.frames(3000, QUIET)).toBeNull();
  });
});
