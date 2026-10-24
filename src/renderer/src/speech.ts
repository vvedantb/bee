// Mic audio → spoken phrases → Grok STT (via main) → pipeline lines. The words are never shown.
// Kept free of window/React/Web Audio so tests can drive it with synthetic frames.
import type { TranscribeResult } from "../../shared/ipc";

/** A frame at or above this RMS (about −40 dBFS) counts as speech. */
export const SPEECH_RMS = 0.01;
/** Audio kept from before speech starts, so the first syllable is not clipped. */
export const PRE_ROLL_MS = 300;
/** This much silence after speech ends the phrase. */
export const END_SILENCE_MS = 800;
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

function concat(frames: Float32Array[]): Float32Array {
  const out = new Float32Array(frames.reduce((total, frame) => total + frame.length, 0));
  let offset = 0;
  for (const frame of frames) {
    out.set(frame, offset);
    offset += frame.length;
  }
  return out;
}

/**
 * Energy-based phrase detector. push() returns the frame's RMS level for the meter.
 * onSpeechEnd fires when a phrase ends with at least MIN_SPEECH_MS of speech, just before onPhrase: the moment to show "Got it…".
 * A cough or click fires neither.
 */
export function createSegmenter(args: { sampleRate: number; onPhrase: (samples: Float32Array) => void; onSpeechEnd?: () => void }) {
  const msPerSample = 1000 / args.sampleRate;
  let frames: Float32Array[] = [];
  let bufferedMs = 0;
  let active = false;
  let speechMs = 0;
  let silenceMs = 0;

  function reset(): void {
    frames = [];
    bufferedMs = 0;
    active = false;
    speechMs = 0;
    silenceMs = 0;
  }

  function end(): void {
    if (speechMs >= MIN_SPEECH_MS) {
      const samples = concat(frames);
      reset();
      args.onSpeechEnd?.();
      args.onPhrase(samples);
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
      } else {
        silenceMs += ms;
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

/**
 * One mic session. Phrases are transcribed one at a time, in order, and each non-empty transcript goes to onLine.
 * onError gets a short message when a transcription fails, and null once one succeeds again.
 * onSpeechEnd fires the moment a phrase ends, before any encoding or STT. onSettled fires once that phrase's STT is done and
 * onLine or onError has run. Timings go to console.debug as numbers only.
 */
export function startMicSession(args: {
  sampleRate: number;
  transcribe: (wav: Uint8Array<ArrayBuffer>) => Promise<TranscribeResult>;
  onLine: (text: string) => void;
  onError: (message: string | null) => void;
  onSpeechEnd?: () => void;
  onSettled?: () => void;
}) {
  let queue = Promise.resolve();
  let speechEndAt = 0;

  async function send(samples: Float32Array, endedAt: number): Promise<void> {
    const sttStart = performance.now();
    try {
      const { text, error } = await args.transcribe(encodeWav(samples, args.sampleRate));
      const done = performance.now();
      console.debug(`perf stt-renderer ${Math.round(done - sttStart)}ms, ${Math.round(done - endedAt)}ms since speech end`);
      args.onError(error);
      if (text) args.onLine(text);
    } catch (error) {
      args.onError(error instanceof Error ? error.message : "Speech-to-text failed");
    } finally {
      args.onSettled?.();
    }
  }

  const segmenter = createSegmenter({
    sampleRate: args.sampleRate,
    onSpeechEnd: () => {
      speechEndAt = performance.now();
      args.onSpeechEnd?.();
    },
    onPhrase: (samples) => {
      const endedAt = speechEndAt;
      queue = queue.then(() => send(samples, endedAt));
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
