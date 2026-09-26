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

/** Energy-based phrase detector. push() returns the frame's RMS level for the meter. */
export function createSegmenter(args: { sampleRate: number; onPhrase: (samples: Float32Array) => void }) {
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
    if (speechMs >= MIN_SPEECH_MS) args.onPhrase(concat(frames));
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

/** Mono float samples → 16 kHz 16-bit PCM WAV. Downsampling averages each output sample's input span. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const ratio = sampleRate / WAV_SAMPLE_RATE;
  const length = Math.floor(samples.length / ratio);
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
    const start = Math.floor(index * ratio);
    const stop = Math.max(start + 1, Math.floor((index + 1) * ratio));
    let sum = 0;
    for (let at = start; at < stop; at += 1) sum += samples[at] ?? 0;
    const sample = Math.max(-1, Math.min(1, sum / (stop - start)));
    view.setInt16(44 + index * 2, Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), true);
  }
  return bytes;
}

/**
 * One mic session. Phrases are transcribed one at a time, in order, and each non-empty transcript goes to onLine.
 * onError gets a short message when a transcription fails, and null once one succeeds again.
 */
export function startMicSession(args: {
  sampleRate: number;
  transcribe: (wav: Uint8Array<ArrayBuffer>) => Promise<TranscribeResult>;
  onLine: (text: string) => void;
  onError: (message: string | null) => void;
}) {
  let queue = Promise.resolve();

  async function send(samples: Float32Array): Promise<void> {
    try {
      const { text, error } = await args.transcribe(encodeWav(samples, args.sampleRate));
      args.onError(error);
      if (text) args.onLine(text);
    } catch (error) {
      args.onError(error instanceof Error ? error.message : "Speech-to-text failed");
    }
  }

  const segmenter = createSegmenter({
    sampleRate: args.sampleRate,
    onPhrase: (samples) => {
      queue = queue.then(() => send(samples));
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
