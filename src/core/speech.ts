// Audio → spoken phrases → speech-to-text (in main) → pipeline lines. The words are never shown. Shared by the mic (renderer)
// and call audio (main/teams-audio-capture.ts), so it is free of window, React, Web Audio and Electron.
import type { TranscribeResult } from "../shared/ipc";

/** A frame at or above this RMS (about −40 dBFS) counts as speech. */
export const SPEECH_RMS = 0.01;
/** Audio kept from before speech starts, so the first syllable is not clipped. */
export const PRE_ROLL_MS = 300;
/** This much silence after speech ends the phrase. */
export const END_SILENCE_MS = 800;
/**
 * This much silence after speech cuts the phrase early: its audio so far goes to speech-to-text at once, and the text is the
 * phrase's line when no speech follows before END_SILENCE_MS. Speech before then resumes the phrase (a thinking pause).
 */
export const EARLY_END_MS = 400;
/** Phrases with less speech than this (a click, a cough) are dropped before any Gateway call. */
export const MIN_SPEECH_MS = 300;
/** Long monologues are cut here so tips keep up. */
export const MAX_PHRASE_MS = 15_000;
/** Grok STT gets 16 kHz 16-bit mono WAV: small uploads, plenty for speech. */
export const WAV_SAMPLE_RATE = 16_000;

export function frameLevel(frame: Float32Array): number {
  let sum = 0;
  for (const sample of frame) sum += sample * sample;
  return frame.length === 0 ? 0 : Math.sqrt(sum / frame.length);
}

/** The frame's largest absolute sample, for clipping (renderer/src/hints.ts). */
export function framePeak(frame: Float32Array): number {
  let peak = 0;
  for (const sample of frame) peak = Math.max(peak, Math.abs(sample));
  return peak;
}

function concat(frames: Float32Array[]): Float32Array {
  const out = new Float32Array(frames.reduce((total, frame) => total + frame.length, 0));
  let offset = 0;
  for (const frame of frames) {
    out.set(frame, offset);
    offset += frame.length;
  }
  return out;
}

/** What the segmenter saw. early: EARLY_END_MS of silence after speech, so the phrase may be over (its audio so far). resume:
 * speech came back after an early cut, before the phrase ended. end: the phrase is over (END_SILENCE_MS of silence, the
 * maximum length, or flush), with all its audio. A phrase can have several early and resume events, and ends once. */
export type SegmentEvent = { kind: "early"; samples: Float32Array } | { kind: "resume" } | { kind: "end"; samples: Float32Array };

/**
 * Energy-based phrase detector. push() returns the frame's RMS level for the meter. Events fire inside push() or flush().
 * Phrases with less than MIN_SPEECH_MS of speech (a cough, a click) fire nothing.
 */
export function createSegmenter(args: { sampleRate: number; onEvent: (event: SegmentEvent) => void }) {
  const msPerSample = 1000 / args.sampleRate;
  let frames: Float32Array[] = [];
  let bufferedMs = 0;
  let active = false;
  let speechMs = 0;
  let silenceMs = 0;
  // An early event went out and no speech came since.
  let early = false;

  function reset(): void {
    frames = [];
    bufferedMs = 0;
    active = false;
    speechMs = 0;
    silenceMs = 0;
    early = false;
  }

  function end(): void {
    if (speechMs >= MIN_SPEECH_MS) {
      const samples = concat(frames);
      reset();
      args.onEvent({ kind: "end", samples });
      return;
    }
    reset();
  }

  return {
    push(frame: Float32Array): number {
      const level = frameLevel(frame);
      const ms = frame.length * msPerSample;
      const voiced = level >= SPEECH_RMS;
      frames.push(frame);
      bufferedMs += ms;
      if (!active && !voiced) {
        while (frames.length > 1 && bufferedMs - (frames[0]?.length ?? 0) * msPerSample >= PRE_ROLL_MS) {
          bufferedMs -= (frames.shift()?.length ?? 0) * msPerSample;
        }
        return level;
      }
      active = true;
      if (voiced) {
        speechMs += ms;
        silenceMs = 0;
        if (early) {
          early = false;
          args.onEvent({ kind: "resume" });
        }
      } else {
        silenceMs += ms;
      }
      if (!early && silenceMs >= EARLY_END_MS && speechMs >= MIN_SPEECH_MS) {
        early = true;
        args.onEvent({ kind: "early", samples: concat(frames) });
      }
      if (silenceMs >= END_SILENCE_MS || bufferedMs >= MAX_PHRASE_MS) end();
      return level;
    },
    /** Ends any phrase in progress (mic off). */
    flush(): void {
      if (active) end();
      else reset();
    },
  };
}

// Downsampling low-passes first, so sound above 8 kHz (sibilants, room noise) cannot fold back into the band STT hears.
// Averaging each output sample's input span did not: it passed 10 kHz at −6 dB, dulled 6 kHz by 2 dB and, at 44.1 kHz, jittered.
/** Each output sample weighs input this many output samples either side: flat to 6 kHz, ≥ 47 dB down from 9 kHz. */
const RESAMPLE_ZEROS = 8;
/** Where the low-pass is centred, as a share of the 8 kHz limit of a 16 kHz WAV. */
const RESAMPLE_CUTOFF = 0.9;

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * Windowed-sinc resampling to WAV_SAMPLE_RATE. Output sample n sits at input position n·from/to; that position's fraction
 * repeats every `to / gcd` samples, so each fraction's weights are worked out once.
 */
function resample(samples: Float32Array, sampleRate: number): Float32Array {
  const rate = Math.round(sampleRate);
  const divisor = gcd(rate, WAV_SAMPLE_RATE);
  const step = rate / divisor;
  const phases = WAV_SAMPLE_RATE / divisor;
  // Cutoff and window width in input samples.
  const cutoff = (RESAMPLE_CUTOFF * Math.min(rate, WAV_SAMPLE_RATE)) / (2 * rate);
  const reach = RESAMPLE_ZEROS * Math.max(1, rate / WAV_SAMPLE_RATE);
  const taps = 2 * Math.ceil(reach);
  const weights = new Float64Array(phases * taps);
  for (let phase = 0; phase < phases; phase += 1) {
    const offset = phase / phases;
    let total = 0;
    for (let tap = 0; tap < taps; tap += 1) {
      const x = tap - taps / 2 + 1 - offset;
      const sinc = x === 0 ? 1 : Math.sin(2 * Math.PI * cutoff * x) / (2 * Math.PI * cutoff * x);
      const window = Math.abs(x) >= reach ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * x) / reach);
      weights[phase * taps + tap] = sinc * window;
      total += sinc * window;
    }
    // Unity gain at every fraction, so a steady level stays steady.
    for (let tap = 0; tap < taps; tap += 1) weights[phase * taps + tap] = (weights[phase * taps + tap] ?? 0) / total;
  }
  const out = new Float32Array(Math.floor((samples.length * phases) / step));
  for (let index = 0; index < out.length; index += 1) {
    const position = index * step;
    const phase = position % phases;
    const first = (position - phase) / phases - taps / 2 + 1;
    const row = phase * taps - first;
    // Input before the start or past the end counts as silence.
    const stop = Math.min(first + taps, samples.length);
    let sum = 0;
    for (let at = Math.max(first, 0); at < stop; at += 1) sum += (samples[at] ?? 0) * (weights[row + at] ?? 0);
    out[index] = sum;
  }
  return out;
}

/** Mono float samples → 16 kHz 16-bit PCM WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const pcm = resample(samples, sampleRate);
  const length = pcm.length;
  const bytes = new Uint8Array(44 + length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, WAV_SAMPLE_RATE, true);
  view.setUint32(28, WAV_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, length * 2, true);
  for (let index = 0; index < length; index += 1) {
    const sample = Math.max(-1, Math.min(1, pcm[index] ?? 0));
    view.setInt16(44 + index * 2, Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), true);
  }
  return bytes;
}

/** How a phrase's speech-to-text ended: words came back, none did (noise, a cough), or the call failed. */
export type PhraseOutcome = "words" | "empty" | "failed";

/**
 * A phrase's line. The first one for an id is a new line; a later one with the same id revises it. final false: an early
 * result (EARLY_END_MS), shown at once; the phrase's final line follows with final true (the same text, or the whole phrase's
 * when speech resumed after the early cut).
 */
export type PhraseLine = { id: number; text: string; final: boolean };

// Phrase ids, unique in this process: main's call audio captures and the renderer's mic sessions never reuse one.
let phraseSeq = 0;

type Phrase = {
  id: number;
  /** The first early cut's audio and when it came: the only cut transcribed early (one early request per phrase at most). */
  early: { samples: Float32Array; at: number } | null;
  /** Speech came back after the first early cut: its result, if any, is dropped and the whole phrase is transcribed at the end. */
  resumed: boolean;
  /** Aborts the early request (resume). */
  abort: AbortController;
  /** Resolves with the whole phrase when it ends. over: it has. */
  ended: Promise<Float32Array>;
  end: (samples: Float32Array) => void;
  over: boolean;
  endAt: number;
  /** onSpeechEnd fired and no resume took it back. */
  acked: boolean;
};
/**
 * One mic (or call audio) session. Each phrase is transcribed early, at EARLY_END_MS of silence: that text goes to onLine at once
 * (final false while the phrase may still go on) and, when no speech follows, it is the phrase's final line with no second
 * request. When speech resumes before the phrase ends, the early request is aborted and its text ignored, and the whole phrase
 * is transcribed once at the end: the line it gives revises the early one (same id). One request per phrase at a time, and
 * phrases run one at a time, in order, so lines (and their revisions) arrive in spoken order.
 * onError gets a short message when a transcription fails, and null once one succeeds again.
 * onSpeechEnd fires the moment speech seems over (the early cut, or the end if there was none), before any STT; onResume takes
 * it back when speech resumes. onSettled fires once per phrase, after its final line or error, with its outcome (never the
 * words). Timings go to console.debug as numbers and flags only.
 */
export function startMicSession(args: {
  sampleRate: number;
  transcribe: (wav: Uint8Array<ArrayBuffer>, signal: AbortSignal) => Promise<TranscribeResult>;
  onLine: (line: PhraseLine) => void;
  onError: (message: string | null) => void;
  onSpeechEnd?: () => void;
  onResume?: () => void;
  onSettled?: (outcome: PhraseOutcome) => void;
  /** The perf log label (numbers only). */
  label?: string;
}) {
  const label = args.label ?? "stt-renderer";
  let queue = Promise.resolve();
  let current: Phrase | null = null;

  async function request(samples: Float32Array, signal: AbortSignal, from: number): Promise<TranscribeResult> {
    const sttStart = performance.now();
    try {
      return await args.transcribe(encodeWav(samples, args.sampleRate), signal);
    } catch (error) {
      return { text: null, error: error instanceof Error ? error.message : "Speech-to-text failed" };
    } finally {
      const done = performance.now();
      console.debug(`perf ${label} ${Math.round(done - sttStart)}ms, ${Math.round(done - from)}ms since speech end`);
    }
  }

  async function run(phrase: Phrase): Promise<void> {
    // The early text shown as pending, the early request's time, and the result that is final.
    let shown: string | null = null;
    let earlyMs: number | null = null;
    let result: TranscribeResult = { text: null, error: null };
    try {
      const early = phrase.early;
      if (early && !phrase.over && !phrase.resumed) {
        const first = await request(early.samples, phrase.abort.signal, early.at);
        earlyMs = Math.round(performance.now() - early.at);
        if (!phrase.resumed && !phrase.over && first.text) {
          // Still inside the phrase: show the text now, pending.
          shown = first.text;
          args.onLine({ id: phrase.id, text: first.text, final: false });
        }
        await phrase.ended;
        // No speech after the early cut: its result is the final one, with no second request.
        if (!phrase.resumed) result = first;
      }
      const whole = await phrase.ended;
      if (phrase.resumed || earlyMs === null) result = await request(whole, new AbortController().signal, phrase.endAt);
    } finally {
      // The whole phrase found no words or failed: the early text shown stays, as final.
      const text = result.text ?? shown;
      args.onError(text || !result.error ? null : result.error);
      if (text) args.onLine({ id: phrase.id, text, final: true });
      const finalMs = Math.max(0, Math.round(performance.now() - phrase.endAt));
      console.debug(`perf ${label} phrase early=${earlyMs ?? "-"} resumed=${phrase.resumed ? 1 : 0} final=${finalMs}ms changed=${shown !== null && text !== shown ? 1 : 0}`);
      args.onSettled?.(text ? "words" : result.error ? "failed" : "empty");
    }
  }

  function ack(phrase: Phrase): void {
    if (phrase.acked) return;
    phrase.acked = true;
    args.onSpeechEnd?.();
  }

  /** The phrase in progress, or a new one queued behind the others. */
  function phraseNow(): Phrase {
    if (current) return current;
    let end: (samples: Float32Array) => void = () => undefined;
    const ended = new Promise<Float32Array>((resolve) => (end = resolve));
    phraseSeq += 1;
    const phrase: Phrase = { id: phraseSeq, early: null, resumed: false, abort: new AbortController(), ended, end, over: false, endAt: 0, acked: false };
    current = phrase;
    queue = queue.then(() => run(phrase)).catch((error: unknown) => args.onError(error instanceof Error ? error.message : "Speech-to-text failed"));
    return phrase;
  }

  const segmenter = createSegmenter({
    sampleRate: args.sampleRate,
    onEvent: (event) => {
      if (event.kind === "early") {
        const phrase = phraseNow();
        ack(phrase);
        // A second pause in the same phrase sends nothing: the end does.
        phrase.early ??= { samples: event.samples, at: performance.now() };
        return;
      }
      if (event.kind === "resume") {
        const phrase = current;
        if (!phrase) return;
        phrase.resumed = true;
        phrase.abort.abort();
        if (!phrase.acked) return;
        phrase.acked = false;
        args.onResume?.();
        return;
      }
      const phrase = phraseNow();
      current = null;
      phrase.over = true;
      phrase.endAt = performance.now();
      ack(phrase);
      phrase.end(event.samples);
    },
  });

  return {
    push: segmenter.push,
    /** Sends the phrase in progress, then resolves once every queued phrase is done. */
    stop(): Promise<void> {
      segmenter.flush();
      return queue;
    },
  };
}
