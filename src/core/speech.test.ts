import { fileURLToPath } from "node:url";
import { describe, expect, it, vi, type Mock } from "vitest";
import { readWav, speechSpans } from "../../test/helpers/wav";
import { transcribeRequestSchema, type TranscribeResult } from "../shared/ipc";
import { EARLY_END_MS, END_SILENCE_MS, MAX_PHRASE_MS, MIN_SPEECH_MS, WAV_SAMPLE_RATE, createSegmenter, encodeWav, frameLevel, startMicSession, type PhraseLine, type SegmentEvent } from "./speech";

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

/** A segmenter event handler that passes each phrase's end (its whole audio) to onPhrase. */
const onEnd = (onPhrase: (samples: Float32Array) => void) => (event: SegmentEvent) => {
  if (event.kind === "end") onPhrase(event.samples);
};

describe("frameLevel", () => {
  it("returns RMS: 0 for silence, amplitude/√2 for a sine", () => {
    expect(frameLevel(silence())).toBe(0);
    expect(frameLevel(tone(0.2))).toBeCloseTo(0.2 / Math.SQRT2, 2);
  });
});

describe("createSegmenter", () => {
  it("emits one phrase after speech followed by silence, with pre-roll", () => {
    const onPhrase = vi.fn();
    const segmenter = createSegmenter({ sampleRate: RATE, onEvent: onEnd(onPhrase) });
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
    const segmenter = createSegmenter({ sampleRate: RATE, onEvent: onEnd(onPhrase) });
    feed(segmenter.push, [tone()], frames(END_SILENCE_MS, silence));
    expect(onPhrase).not.toHaveBeenCalled();
  });

  it("cuts long speech at the maximum phrase length", () => {
    const onPhrase = vi.fn();
    const segmenter = createSegmenter({ sampleRate: RATE, onEvent: onEnd(onPhrase) });
    feed(segmenter.push, frames(MAX_PHRASE_MS + 1000, tone));
    expect(onPhrase).toHaveBeenCalledTimes(1);
  });

  it("flush() ends a phrase in progress and ignores silence", () => {
    const onPhrase = vi.fn();
    const segmenter = createSegmenter({ sampleRate: RATE, onEvent: onEnd(onPhrase) });
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
const FIXTURE = fileURLToPath(new URL("../../test/fixtures/london-tube-question.wav", import.meta.url));
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

  // espeak-ng ends each phrase with about 0.5 s of near-silence, so speech ends before the script's silences start.
  it("has two phrases, measured from its samples", () => {
    expect(spans.map(({ start, end }) => [Number(start.toFixed(2)), Number(end.toFixed(2))])).toEqual([
      [0.6, 3.2],
      [6.19, 8.22],
    ]);
  });

  it.each([wav.rate, RATE])("cuts one whole phrase per line, with pre-roll before the onset, at %i Hz", (rate) => {
    const samples = rate === wav.rate ? wav.samples : resample(wav.samples, wav.rate, rate);
    const phrases: Array<{ start: number; end: number; samples: Float32Array }> = [];
    let pushed = 0;
    const segmenter = createSegmenter({
      sampleRate: rate,
      // Fires inside push(), after the frame that ended the phrase was counted.
      onEvent: onEnd((phrase) => phrases.push({ start: (pushed - phrase.length) / rate, end: pushed / rate, samples: phrase })),
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

/** Samples and header rate of a 16-bit mono WAV from encodeWav. */
function decode(wav: Uint8Array<ArrayBuffer>): { rate: number; samples: Float32Array } {
  const view = new DataView(wav.buffer);
  expect(view.getUint32(40, true)).toBe(wav.byteLength - 44);
  return { rate: view.getUint32(24, true), samples: Float32Array.from({ length: (wav.byteLength - 44) / 2 }, (_, index) => view.getInt16(44 + index * 2, true) / 0x8000) };
}

/**
 * A 16 kHz signal at a fractional sample position: windowed sinc over ±32 samples. sin(π(position − k)) is ±sin(π·fraction),
 * so each value costs one sine. Stands in for Chromium's resampler, which feeds the mic the file at the capture rate.
 */
function sincAt(samples: Float32Array, position: number): number {
  const base = Math.floor(position);
  const fraction = position - base;
  if (fraction === 0) return samples[base] ?? 0;
  const sine = Math.sin(Math.PI * fraction);
  let sum = 0;
  for (let at = base - 31; at <= base + 32; at += 1) {
    const distance = position - at;
    const window = (1 - (distance / 32) ** 2) ** 2;
    sum += (samples[at] ?? 0) * ((base - at) % 2 === 0 ? 1 : -1) * (sine / (Math.PI * distance)) * window;
  }
  return sum;
}

// The fixture is 16 kHz, so at the capture rate it holds nothing above 8 kHz: a clean encoder should give the file back.
describe("encodeWav on the live mic fixture", () => {
  const wav = readWav(FIXTURE);

  it.each([44_100, 48_000])("gives back each phrase the segmenter cuts, in 4096-sample frames at %i Hz", (rate) => {
    const scale = wav.rate / rate;
    const samples = Float32Array.from({ length: Math.floor(wav.samples.length / scale) }, (_, index) => sincAt(wav.samples, index * scale));
    const phrases: Array<{ from: number; samples: Float32Array }> = [];
    let pushed = 0;
    // As startMicSession does: each phrase the segmenter emits goes to encodeWav at the capture rate.
    const segmenter = createSegmenter({ sampleRate: rate, onEvent: onEnd((phrase) => phrases.push({ from: pushed - phrase.length, samples: phrase })) });
    for (let at = 0; at < samples.length; at += FRAME) {
      const frame = samples.slice(at, at + FRAME);
      pushed += frame.length;
      segmenter.push(frame);
    }
    segmenter.flush();
    expect(phrases.length).toBe(2);

    for (const [index, phrase] of phrases.entries()) {
      const label = `phrase ${index + 1} at ${rate} Hz`;
      const encoded = decode(encodeWav(phrase.samples, rate));
      expect(encoded.rate, label).toBe(WAV_SAMPLE_RATE);
      // Within one 16 kHz sample of the captured audio's duration.
      expect(Math.abs(encoded.samples.length / WAV_SAMPLE_RATE - phrase.samples.length / rate), label).toBeLessThan(1 / WAV_SAMPLE_RATE);
      // Output sample n is the file at the phrase's start plus n, a fractional position when the rate is not a multiple of 16 kHz.
      const start = (phrase.from * WAV_SAMPLE_RATE) / rate;
      const original = Float32Array.from(encoded.samples, (_, at) => sincAt(wav.samples, start + at));
      const residual = Float32Array.from(encoded.samples, (sample, at) => sample - (original[at] ?? 0));
      // No lag or gain to fit: a dropped, repeated or shifted sample would wreck this.
      const snr = 20 * Math.log10(frameLevel(original) / frameLevel(residual));
      expect(snr, `${label}: SNR against the file, dB`).toBeGreaterThan(30);
      // Each capture frame joins the next without a click: the residual there is no worse than over the whole phrase.
      for (let boundary = FRAME; boundary < phrase.samples.length; boundary += FRAME) {
        const at = Math.round((boundary * WAV_SAMPLE_RATE) / rate);
        expect(frameLevel(residual.slice(at - 16, at + 16)), `${label}: frame boundary at input ${boundary}`).toBeLessThan(
          4 * frameLevel(residual) + 1e-4,
        );
      }
    }
  });
});

describe("createSegmenter events", () => {
  function events() {
    const seen: Array<{ kind: SegmentEvent["kind"]; ms: number }> = [];
    const segmenter = createSegmenter({
      sampleRate: RATE,
      onEvent: (event) => seen.push({ kind: event.kind, ms: event.kind === "resume" ? 0 : Math.round((event.samples.length / RATE) * 1000) }),
    });
    return { segmenter, kinds: () => seen.map((event) => event.kind), seen };
  }

  it("cuts early once the early silence has passed, then ends the same phrase at the end silence", () => {
    const { segmenter, kinds, seen } = events();
    feed(segmenter.push, frames(1000, tone), frames(EARLY_END_MS - 2 * FRAME_MS, silence));
    expect(kinds()).toEqual([]);
    feed(segmenter.push, frames(3 * FRAME_MS, silence));
    expect(kinds()).toEqual(["early"]);
    feed(segmenter.push, frames(END_SILENCE_MS - EARLY_END_MS, silence));
    expect(kinds()).toEqual(["early", "end"]);
    // The early cut holds the speech so far; the end holds it all, its silence included.
    expect(seen[1]?.ms ?? 0).toBeGreaterThan((seen[0]?.ms ?? 0) + 300);
  });

  it("resumes the phrase when speech comes back before the end silence, and ends it once with all its audio", () => {
    const { segmenter, kinds, seen } = events();
    feed(segmenter.push, frames(800, tone), frames(EARLY_END_MS + 100, silence), frames(800, tone));
    expect(kinds()).toEqual(["early", "resume"]);
    // A second pause cuts early again; the end comes once.
    feed(segmenter.push, frames(END_SILENCE_MS + 100, silence));
    expect(kinds()).toEqual(["early", "resume", "early", "end"]);
    expect(seen.at(-1)?.ms ?? 0).toBeGreaterThan(2000);
  });

  it("needs at least the minimum speech: a cough or click fires nothing", () => {
    const { segmenter, kinds } = events();
    feed(segmenter.push, [tone()], frames(END_SILENCE_MS + 200, silence));
    expect(kinds()).toEqual([]);
    // Just over the minimum does fire.
    feed(segmenter.push, frames(MIN_SPEECH_MS + FRAME_MS, tone), frames(END_SILENCE_MS + 200, silence));
    expect(kinds()).toEqual(["early", "end"]);
  });

  it("ends a phrase cut at the maximum length, and at flush, with no early cut; after a resume the cap still ends it", () => {
    const { segmenter, kinds } = events();
    feed(segmenter.push, frames(MAX_PHRASE_MS + 1000, tone));
    expect(kinds()).toEqual(["end"]);
    segmenter.flush();
    expect(kinds()).toEqual(["end", "end"]);
    feed(segmenter.push, frames(800, tone), frames(EARLY_END_MS + 100, silence), frames(MAX_PHRASE_MS, tone));
    expect(kinds()).toEqual(["end", "end", "early", "resume", "end"]);
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

  it("tells onSettled whether words came back, none did, or the call failed, never the words", async () => {
    const replies: TranscribeResult[] = [
      { text: "hello there", error: null },
      { text: null, error: null },
      { text: null, error: "Speech-to-text failed: x" },
    ];
    const outcomes: unknown[][] = [];
    const mic = startMicSession({
      sampleRate: RATE,
      transcribe: async () => replies.shift() ?? { text: null, error: null },
      onLine: vi.fn(),
      onError: vi.fn(),
      onSettled: (...args: unknown[]) => outcomes.push(args),
    });
    for (let phrase = 0; phrase < 3; phrase += 1) feed(mic.push, frames(800, tone), frames(END_SILENCE_MS + 200, silence));
    await mic.stop();
    expect(outcomes).toEqual([["words"], ["empty"], ["failed"]]);
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
    // Away from the edges, where the filter reaches past the samples.
    expect(view.getInt16(44 + 2 * (WAV_SAMPLE_RATE / 2), true)).toBe(Math.round(0.5 * 0x7fff));
  });

  // A tone at the capture rate, encoded, as dB relative to the input level, measured clear of the edges.
  function toneGain(hz: number, rate: number): number {
    const wav = encodeWav(Float32Array.from({ length: rate }, (_, index) => 0.5 * Math.sin((2 * Math.PI * hz * index) / rate)), rate);
    const out = decode(wav).samples.slice(2000, -2000);
    return 20 * Math.log10(frameLevel(out) / (0.5 / Math.SQRT2));
  }

  it.each([44_100, 48_000])("keeps 0–6 kHz and rejects 9–15 kHz before downsampling from %i Hz", (rate) => {
    for (const hz of [300, 1000, 3000, 6000]) expect(Math.abs(toneGain(hz, rate)), `${hz} Hz passes`).toBeLessThan(1);
    // Above 8 kHz a 16 kHz WAV cannot hold the tone, so anything left is aliasing.
    for (const hz of [9000, 10_000, 12_000, 15_000]) expect(toneGain(hz, rate), `${hz} Hz is rejected`).toBeLessThan(-40);
  });

  it("clips out-of-range samples", () => {
    const view = new DataView(encodeWav(Float32Array.from([2, -2]), WAV_SAMPLE_RATE).buffer);
    expect(view.getInt16(44, true)).toBe(0x7fff);
    expect(view.getInt16(46, true)).toBe(-0x8000);
  });
});

/** The text of each line a session handed over; each is final (the speech is fed at once, so no early line shows). */
function texts(onLine: Mock<(line: PhraseLine) => void>): string[] {
  return onLine.mock.calls.map(([line]) => {
    expect(line.final).toBe(true);
    return line.text;
  });
}

describe("startMicSession", () => {
  function session(transcribe: (wav: Uint8Array) => Promise<TranscribeResult>) {
    const onLine = vi.fn<(line: PhraseLine) => void>();
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
    expect(texts(onLine)).toEqual(["phrase 1", "phrase 2"]);
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
    expect(texts(onLine)).toEqual(["phrase 1", "phrase 2"]);
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
    expect(texts(onLine)).toEqual(["back again"]);
  });

  it("sends nothing for silence", async () => {
    const transcribe = vi.fn(async () => ({ text: "x", error: null }));
    const { mic } = session(transcribe);
    feed(mic.push, frames(3000, silence));
    await mic.stop();
    expect(transcribe).not.toHaveBeenCalled();
  });
});

describe("startMicSession: early result at the early cut", () => {
  /** A session whose transcribe calls wait until the test answers them, in order. */
  function controlled() {
    const calls: Array<{ seconds: number; signal: AbortSignal; answer: (text: string | null) => void }> = [];
    let busy = 0;
    let most = 0;
    const lines: PhraseLine[] = [];
    const events: string[] = [];
    const mic = startMicSession({
      sampleRate: RATE,
      transcribe: (wav, signal) =>
        new Promise<TranscribeResult>((resolve) => {
          busy += 1;
          most = Math.max(most, busy);
          const answer = (text: string | null) => {
            busy -= 1;
            resolve({ text, error: null });
          };
          // As main does: an aborted request comes back with no words.
          signal.addEventListener("abort", () => answer(null), { once: true });
          calls.push({ seconds: (wav.byteLength - 44) / 2 / WAV_SAMPLE_RATE, signal, answer });
        }),
      onLine: (line) => lines.push(line),
      onError: () => undefined,
      onSpeechEnd: () => events.push("ack"),
      onResume: () => events.push("resume"),
      onSettled: (outcome) => events.push(outcome),
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    return { mic, calls, lines, events, settle, most: () => most };
  }

  it("a phrase with no resume makes one request: its early text shows pending, then the same text is final", async () => {
    const t = controlled();
    feed(t.mic.push, frames(1000, tone), frames(EARLY_END_MS + 50, silence));
    await t.settle();
    expect(t.calls).toHaveLength(1);
    expect(t.events).toEqual(["ack"]);
    t.calls[0]?.answer("Can we ship on Friday?");
    await t.settle();
    expect(t.lines).toEqual([{ id: expect.any(Number), text: "Can we ship on Friday?", final: false }]);
    feed(t.mic.push, frames(END_SILENCE_MS - EARLY_END_MS, silence));
    await t.mic.stop();
    expect(t.calls).toHaveLength(1);
    expect(t.lines.map((line) => [line.id, line.text, line.final])).toEqual([
      [t.lines[0]?.id, "Can we ship on Friday?", false],
      [t.lines[0]?.id, "Can we ship on Friday?", true],
    ]);
    expect(t.events).toEqual(["ack", "words"]);
  });

  it("an early result that lands after the phrase ended is the final line at once", async () => {
    const t = controlled();
    feed(t.mic.push, frames(1000, tone), frames(EARLY_END_MS + 50, silence));
    await t.settle();
    feed(t.mic.push, frames(END_SILENCE_MS, silence));
    t.calls[0]?.answer("Can we ship on Friday?");
    await t.mic.stop();
    expect(t.calls).toHaveLength(1);
    expect(t.lines).toEqual([{ id: expect.any(Number), text: "Can we ship on Friday?", final: true }]);
  });

  it("speech after the early cut aborts the early request, ignores it and transcribes the whole phrase once, as a revision", async () => {
    const t = controlled();
    feed(t.mic.push, frames(1000, tone), frames(EARLY_END_MS + 50, silence));
    await t.settle();
    t.calls[0]?.answer("Bee, open");
    await t.settle();
    expect(t.lines).toEqual([{ id: expect.any(Number), text: "Bee, open", final: false }]);
    // A thinking pause, then the rest of the phrase, and a second pause: no second early request.
    feed(t.mic.push, frames(800, tone), frames(EARLY_END_MS + 50, silence));
    await t.settle();
    expect(t.calls).toHaveLength(1);
    feed(t.mic.push, frames(END_SILENCE_MS, silence));
    await t.settle();
    expect(t.calls).toHaveLength(2);
    // The whole phrase: both bursts of speech.
    expect(t.calls[1]?.seconds ?? 0).toBeGreaterThan(2);
    t.calls[1]?.answer("Bee, open Teams");
    await t.mic.stop();
    expect(t.lines.map((line) => [line.id, line.text, line.final])).toEqual([
      [t.lines[0]?.id, "Bee, open", false],
      [t.lines[0]?.id, "Bee, open Teams", true],
    ]);
    expect(t.events).toEqual(["ack", "resume", "ack", "words"]);
  });

  it("a resume while the early request is in flight aborts it and runs one request at a time", async () => {
    const t = controlled();
    feed(t.mic.push, frames(1000, tone), frames(EARLY_END_MS + 50, silence));
    await t.settle();
    feed(t.mic.push, frames(500, tone));
    expect(t.calls[0]?.signal.aborted).toBe(true);
    feed(t.mic.push, frames(END_SILENCE_MS, silence));
    await t.settle();
    expect(t.calls).toHaveLength(2);
    t.calls[1]?.answer("Let's check the roadmap first");
    await t.mic.stop();
    // The aborted early request showed nothing.
    expect(t.lines).toEqual([{ id: expect.any(Number), text: "Let's check the roadmap first", final: true }]);
    expect(t.most()).toBe(1);
  });

  it("keeps two phrases in order, the second's early request waiting for the first's final", async () => {
    const t = controlled();
    // Phrase 1 resumes after its early request started, so it needs a second request at its end.
    feed(t.mic.push, frames(800, tone), frames(EARLY_END_MS + 50, silence));
    await t.settle();
    feed(t.mic.push, frames(500, tone), frames(END_SILENCE_MS, silence));
    await t.settle();
    expect(t.calls).toHaveLength(2);
    // Phrase 2 is cut early while phrase 1's request is in flight: its request waits.
    feed(t.mic.push, frames(800, tone), frames(EARLY_END_MS + 50, silence));
    await t.settle();
    expect(t.calls).toHaveLength(2);
    t.calls[1]?.answer("first phrase");
    await t.settle();
    expect(t.calls).toHaveLength(3);
    t.calls[2]?.answer("second phrase");
    await t.mic.stop();
    expect(t.lines.map((line) => [line.text, line.final])).toEqual([
      ["first phrase", true],
      ["second phrase", true],
    ]);
    expect(t.lines[0]?.id).toBeLessThan(t.lines[1]?.id ?? 0);
    expect(t.most()).toBe(1);
  });

  it("logs each phrase's early and final timings as numbers and flags, never the words", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    try {
      const t = controlled();
      feed(t.mic.push, frames(1000, tone), frames(EARLY_END_MS + 50, silence));
      await t.settle();
      t.calls[0]?.answer("secret words");
      feed(t.mic.push, frames(END_SILENCE_MS, silence));
      await t.mic.stop();
      const logged = debug.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(logged).toMatch(/perf stt-renderer phrase early=\d+ resumed=0 final=\d+ms changed=0/);
      expect(logged).not.toContain("secret");
    } finally {
      debug.mockRestore();
    }
  });
});

describe("transcribeRequestSchema", () => {
  it("rejects empty and oversized audio", () => {
    expect(transcribeRequestSchema.safeParse({ audio: new Uint8Array(44), sessionToken: "t" }).success).toBe(false);
    expect(transcribeRequestSchema.safeParse({ audio: new Uint8Array(2_000_001), sessionToken: "t" }).success).toBe(false);
    expect(transcribeRequestSchema.safeParse({ audio: "not bytes", sessionToken: "t" }).success).toBe(false);
  });
});
