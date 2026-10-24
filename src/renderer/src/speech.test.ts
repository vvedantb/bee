import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { readWav, speechSpans } from "../../../test/helpers/wav";
import { transcribeRequestSchema, type TranscribeResult } from "../../shared/ipc";
import { END_SILENCE_MS, MAX_PHRASE_MS, MIN_SPEECH_MS, WAV_SAMPLE_RATE, createSegmenter, encodeWav, frameLevel, startMicSession } from "./speech";

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

// The live mic E2E fixture (espeak-ng): "what's in the news in London today", 2.5 s of silence, "why are there tube closures".
// Its samples go through the segmenter frame by frame, as the store's mic does, at the file's rate and resampled to 48 kHz.
const FIXTURE = fileURLToPath(new URL("../../../test/fixtures/london-tube-question.wav", import.meta.url));
// A sample at or above this is speech; a quieter gap this long separates phrases.
const SAMPLE_LEVEL = 0.001;
const GAP_S = 0.5;

/** Linear interpolation to another rate. */
function resample(samples: Float32Array, from: number, to: number): Float32Array {
  return Float32Array.from({ length: Math.floor((samples.length * to) / from) }, (_, index) => {
    const at = (index * from) / to;
    const low = Math.floor(at);
    return (samples[low] ?? 0) + ((samples[low + 1] ?? 0) - (samples[low] ?? 0)) * (at - low);
  });
}

describe("createSegmenter on the live mic fixture", () => {
  const wav = readWav(FIXTURE);
  const spans = speechSpans(wav, SAMPLE_LEVEL, GAP_S);

  // espeak-ng's audio ends before the times in the fixture's script (2.85 s and 7.12 s).
  it("has two phrases, measured from its samples", () => {
    expect(spans.map(({ start, end }) => [Number(start.toFixed(2)), Number(end.toFixed(2))])).toEqual([
      [0.6, 2.5],
      [5.35, 6.77],
    ]);
  });

  it.each([wav.rate, RATE])("cuts one whole phrase per line, with pre-roll before the onset, at %i Hz", (rate) => {
    const samples = rate === wav.rate ? wav.samples : resample(wav.samples, wav.rate, rate);
    const phrases: Array<{ start: number; end: number; samples: Float32Array }> = [];
    let pushed = 0;
    const segmenter = createSegmenter({
      sampleRate: rate,
      // Fires inside push(), after the frame that ended the phrase was counted.
      onPhrase: (phrase) => phrases.push({ start: (pushed - phrase.length) / rate, end: pushed / rate, samples: phrase }),
    });
    for (let at = 0; at < samples.length; at += FRAME) {
      const frame = samples.slice(at, at + FRAME);
      pushed += frame.length;
      segmenter.push(frame);
    }
    segmenter.flush();

    expect(phrases.length).toBe(spans.length);
    for (const [index, phrase] of phrases.entries()) {
      const span = spans[index] ?? { start: 0, end: 0 };
      expect(phrase.start, `phrase ${index + 1} starts ≥ 150 ms before the onset`).toBeLessThanOrEqual(span.start - 0.15);
      expect(phrase.end, `phrase ${index + 1} runs past the end of speech`).toBeGreaterThanOrEqual(span.end + END_SILENCE_MS / 1000);
      // The phrase is the file's audio over that span with no frame dropped.
      const from = Math.round(phrase.start * rate);
      expect(phrase.samples).toEqual(samples.slice(from, from + phrase.samples.length));
    }
    // Neither phrase reaches into the other's speech.
    expect(phrases[0]?.end ?? Infinity).toBeLessThan(spans[1]?.start ?? 0);
  });
});

describe("onSpeechEnd", () => {
  it("fires once the end silence has passed, not before, and before onPhrase", () => {
    const order: string[] = [];
    const segmenter = createSegmenter({ sampleRate: RATE, onSpeechEnd: () => order.push("end"), onPhrase: () => order.push("phrase") });
    feed(segmenter.push, frames(1000, tone), frames(END_SILENCE_MS - 2 * FRAME_MS, silence));
    expect(order).toEqual([]);
    feed(segmenter.push, frames(3 * FRAME_MS, silence));
    expect(order).toEqual(["end", "phrase"]);
  });

  it("needs at least the minimum speech: a cough or click fires nothing", () => {
    const onSpeechEnd = vi.fn();
    const onPhrase = vi.fn();
    const segmenter = createSegmenter({ sampleRate: RATE, onSpeechEnd, onPhrase });
    feed(segmenter.push, [tone()], frames(END_SILENCE_MS + 200, silence));
    expect(onSpeechEnd).not.toHaveBeenCalled();
    expect(onPhrase).not.toHaveBeenCalled();
    // Just over the minimum does fire.
    feed(segmenter.push, frames(MIN_SPEECH_MS + FRAME_MS, tone), frames(END_SILENCE_MS + 200, silence));
    expect(onSpeechEnd).toHaveBeenCalledTimes(1);
  });

  it("fires for a flushed phrase and for a phrase cut at the maximum length", () => {
    const onSpeechEnd = vi.fn();
    const segmenter = createSegmenter({ sampleRate: RATE, onSpeechEnd, onPhrase: () => undefined });
    feed(segmenter.push, frames(800, tone));
    segmenter.flush();
    expect(onSpeechEnd).toHaveBeenCalledTimes(1);
    feed(segmenter.push, frames(MAX_PHRASE_MS + 1000, tone));
    expect(onSpeechEnd).toHaveBeenCalledTimes(2);
  });

  it("works without a callback", () => {
    const onPhrase = vi.fn();
    const segmenter = createSegmenter({ sampleRate: RATE, onPhrase });
    feed(segmenter.push, frames(800, tone), frames(END_SILENCE_MS + 200, silence));
    expect(onPhrase).toHaveBeenCalledTimes(1);
  });
});

describe("ack before speech-to-text", () => {
  it("acks before a slow transcribe is even called, and settles only after the line", async () => {
    const events: string[] = [];
    let finish: (result: TranscribeResult) => void = () => undefined;
    const transcribe = vi.fn(
      () =>
        new Promise<TranscribeResult>((resolve) => {
          events.push("stt-start");
          finish = resolve;
        }),
    );
    const mic = startMicSession({
      sampleRate: RATE,
      transcribe,
      onSpeechEnd: () => events.push("ack"),
      onLine: () => events.push("line"),
      onError: () => undefined,
      onSettled: () => events.push("settled"),
    });
    feed(mic.push, frames(800, tone), frames(END_SILENCE_MS + 200, silence));
    // The ack has fired. STT has started but not finished: the transcript is still pending.
    expect(events[0]).toBe("ack");
    await vi.waitFor(() => expect(events).toContain("stt-start"));
    expect(events).not.toContain("line");
    expect(events).not.toContain("settled");
    finish({ text: "hello there", error: null });
    await mic.stop();
    expect(events).toEqual(["ack", "stt-start", "line", "settled"]);
  });

  it("settles after a failed or empty transcription too, and a cough never acks", async () => {
    const onSpeechEnd = vi.fn();
    const onSettled = vi.fn();
    const transcribe = vi.fn(async () => ({ text: null, error: "Speech-to-text failed: x" }));
    const mic = startMicSession({ sampleRate: RATE, transcribe, onSpeechEnd, onLine: vi.fn(), onError: vi.fn(), onSettled });
    feed(mic.push, [tone()], frames(END_SILENCE_MS + 200, silence));
    await mic.stop();
    expect(onSpeechEnd).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
    feed(mic.push, frames(800, tone), frames(END_SILENCE_MS + 200, silence));
    await mic.stop();
    expect(onSpeechEnd).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("logs timings as numbers only", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    try {
      const mic = startMicSession({ sampleRate: RATE, transcribe: async () => ({ text: "secret words here", error: null }), onLine: vi.fn(), onError: vi.fn() });
      feed(mic.push, frames(800, tone), frames(END_SILENCE_MS + 200, silence));
      await mic.stop();
      const logged = debug.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(logged).toMatch(/^perf stt-renderer \d+ms/);
      expect(logged).not.toContain("secret");
    } finally {
      debug.mockRestore();
    }
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
