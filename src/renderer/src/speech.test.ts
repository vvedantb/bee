import { describe, expect, it, vi } from "vitest";
import { transcribeRequestSchema, type TranscribeResult } from "../../shared/ipc";
import { END_SILENCE_MS, MAX_PHRASE_MS, WAV_SAMPLE_RATE, createSegmenter, encodeWav, frameLevel, startMicSession } from "./speech";

const RATE = 48_000;
// 4096 samples at 48 kHz is ~85 ms, the frame size the store uses.
const FRAME = 4096;
const FRAME_MS = (FRAME / RATE) * 1000;

function tone(amplitude = 0.2): Float32Array {
  return Float32Array.from({ length: FRAME }, (_, index) => amplitude * Math.sin((2 * Math.PI * 220 * index) / RATE));
}

function silence(): Float32Array {
  return new Float32Array(FRAME);
}

function frames(ms: number, make: () => Float32Array): Float32Array[] {
  return Array.from({ length: Math.ceil(ms / FRAME_MS) }, make);
}

function feed(push: (frame: Float32Array) => number, ...runs: Float32Array[][]): void {
  for (const run of runs) for (const frame of run) push(frame);
}

describe("frameLevel", () => {
  it("returns RMS: 0 for silence, amplitude/√2 for a sine", () => {
    expect(frameLevel(silence())).toBe(0);
    expect(frameLevel(tone(0.2))).toBeCloseTo(0.2 / Math.SQRT2, 2);
  });
});

describe("createSegmenter", () => {
  it("emits one phrase after speech followed by silence, with pre-roll", () => {
    const onPhrase = vi.fn();
    const segmenter = createSegmenter({ sampleRate: RATE, onPhrase });
    feed(segmenter.push, frames(1000, silence), frames(1000, tone));
    expect(onPhrase).not.toHaveBeenCalled();
    feed(segmenter.push, frames(END_SILENCE_MS, silence));
    expect(onPhrase).toHaveBeenCalledTimes(1);
    const phraseMs = (onPhrase.mock.calls[0]?.[0].length / RATE) * 1000;
    // ~1 s speech + ~0.8 s trailing silence + ≤0.3 s pre-roll (whole frames).
    expect(phraseMs).toBeGreaterThan(1800);
    expect(phraseMs).toBeLessThan(2300);
  });

  it("drops blips shorter than the minimum speech length", () => {
    const onPhrase = vi.fn();
    const segmenter = createSegmenter({ sampleRate: RATE, onPhrase });
    feed(segmenter.push, [tone()], frames(END_SILENCE_MS, silence));
    expect(onPhrase).not.toHaveBeenCalled();
  });

  it("cuts long speech at the maximum phrase length", () => {
    const onPhrase = vi.fn();
    const segmenter = createSegmenter({ sampleRate: RATE, onPhrase });
    feed(segmenter.push, frames(MAX_PHRASE_MS + 1000, tone));
    expect(onPhrase).toHaveBeenCalledTimes(1);
  });

  it("flush() ends a phrase in progress and ignores silence", () => {
    const onPhrase = vi.fn();
    const segmenter = createSegmenter({ sampleRate: RATE, onPhrase });
    feed(segmenter.push, frames(500, silence));
    segmenter.flush();
    expect(onPhrase).not.toHaveBeenCalled();
    feed(segmenter.push, frames(600, tone));
    segmenter.flush();
    expect(onPhrase).toHaveBeenCalledTimes(1);
  });
});

describe("encodeWav", () => {
  it("writes a 16 kHz 16-bit mono WAV, downsampled from 48 kHz", () => {
    const wav = encodeWav(new Float32Array(RATE).fill(0.5), RATE);
    const view = new DataView(wav.buffer);
    const text = (offset: number) => String.fromCharCode(...wav.slice(offset, offset + 4));
    expect([text(0), text(8), text(12), text(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(WAV_SAMPLE_RATE);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(WAV_SAMPLE_RATE * 2);
    expect(wav.byteLength).toBe(44 + WAV_SAMPLE_RATE * 2);
    expect(view.getInt16(44, true)).toBe(Math.round(0.5 * 0x7fff));
  });

  it("clips out-of-range samples", () => {
    const view = new DataView(encodeWav(Float32Array.from([2, -2]), WAV_SAMPLE_RATE).buffer);
    expect(view.getInt16(44, true)).toBe(0x7fff);
    expect(view.getInt16(46, true)).toBe(-0x8000);
  });
});

describe("startMicSession", () => {
  function session(transcribe: (wav: Uint8Array) => Promise<TranscribeResult>) {
    const onLine = vi.fn();
    const onError = vi.fn();
    const mic = startMicSession({ sampleRate: RATE, transcribe, onLine, onError });
    return { mic, onLine, onError };
  }

  it("sends each phrase as a valid IPC request and forwards the transcript to the pipeline", async () => {
    const transcribe = vi.fn(async (wav: Uint8Array) => {
      // What the renderer sends must pass main's zod schema.
      transcribeRequestSchema.parse({ audio: wav, sessionToken: "t" });
      return { text: `phrase ${transcribe.mock.calls.length}`, error: null };
    });
    const { mic, onLine, onError } = session(transcribe);
    feed(mic.push, frames(800, tone), frames(END_SILENCE_MS, silence), frames(800, tone));
    await mic.stop();
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(onLine.mock.calls).toEqual([["phrase 1"], ["phrase 2"]]);
    expect(onError).toHaveBeenLastCalledWith(null);
  });

  it("keeps phrases in order even when an earlier call is slower", async () => {
    const delays = [60, 0];
    const transcribe = vi.fn(async () => {
      const call = transcribe.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, delays[call - 1]));
      return { text: `phrase ${call}`, error: null };
    });
    const { mic, onLine } = session(transcribe);
    feed(mic.push, frames(800, tone), frames(END_SILENCE_MS, silence), frames(800, tone));
    await mic.stop();
    expect(onLine.mock.calls).toEqual([["phrase 1"], ["phrase 2"]]);
  });

  it("does not call the pipeline for phrases with no words", async () => {
    const { mic, onLine, onError } = session(async () => ({ text: null, error: null }));
    feed(mic.push, frames(800, tone));
    await mic.stop();
    expect(onLine).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(null);
  });

  it("reports Gateway errors and thrown IPC errors, then clears once a phrase succeeds", async () => {
    const results: (() => TranscribeResult)[] = [
      () => ({ text: null, error: "Speech-to-text failed: Unauthorized" }),
      () => {
        throw new Error("Sign in to Bee to get guidance.");
      },
      () => ({ text: "back again", error: null }),
    ];
    const { mic, onLine, onError } = session(async () => (results.shift() ?? (() => ({ text: null, error: null })))());
    feed(mic.push, ...Array.from({ length: 3 }, () => [...frames(800, tone), ...frames(END_SILENCE_MS, silence)]));
    await mic.stop();
    expect(onError.mock.calls).toEqual([["Speech-to-text failed: Unauthorized"], ["Sign in to Bee to get guidance."], [null]]);
    expect(onLine.mock.calls).toEqual([["back again"]]);
  });

  it("sends nothing for silence", async () => {
    const transcribe = vi.fn(async () => ({ text: "x", error: null }));
    const { mic } = session(transcribe);
    feed(mic.push, frames(3000, silence));
    await mic.stop();
    expect(transcribe).not.toHaveBeenCalled();
  });
});

describe("transcribeRequestSchema", () => {
  it("rejects empty and oversized audio", () => {
    expect(transcribeRequestSchema.safeParse({ audio: new Uint8Array(44), sessionToken: "t" }).success).toBe(false);
    expect(transcribeRequestSchema.safeParse({ audio: new Uint8Array(2_000_001), sessionToken: "t" }).success).toBe(false);
    expect(transcribeRequestSchema.safeParse({ audio: "not bytes", sessionToken: "t" }).success).toBe(false);
  });
});
