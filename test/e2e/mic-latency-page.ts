// Runs in the harness renderer for the live mic latency test (test/mic-latency.e2e.test.ts): the real store's mic
// (startTestMicCapture: openMic → startMicSession → the store's phrase callbacks → simulateLine → runPipeline), with speech-to-text
// wrapped so each call is timed. Chromium's fake device plays the WAV. No App is rendered. Reports once.
// Times are ms of performance.now() since load, plus the audio clock (samples captured / sample rate). The store's segmenter is
// internal, so a second createSegmenter fed the same frames marks each end of speech: same code, same frames, same cuts.
// The fake device loops the file, so the mic goes off STOP_AFTER_ONSET_S after the first speech, before the loop replays it.
import { createSegmenter } from "../../src/renderer/src/speech";
import { actions, getBeeState, runsStarted, startTestMicCapture } from "../../src/renderer/src/store";

// The file is 12.12 s with speech from 0.6 s, so this is 11.8 s into the file.
const STOP_AFTER_ONSET_S = 11.2;
// After mic off and the store settles, a late run would start within this.
const QUIET_MS = 3_000;
// Inside the test's harness timeout (150 s), so a stuck run still reports what it has.
const DEADLINE_MS = 120_000;
const POLL_MS = 5;
// A sample at or above this is the first speech. The test finds the file's onset with the threshold reported, to align the clocks.
const ONSET_LEVEL = 0.02;

type Segment = { ms: number; audioS: number; phraseS: number };
type Stt = { startMs: number; endMs: number | null; audioS: number; text: string | null; error: string | null };
type Run = { run: number; startMs: number; firstTextMs: number | null; firstText: string[]; finalTips: string[] | null };

const token = new URLSearchParams(location.search).get("token") ?? "";
const started = performance.now();
const now = () => Math.round((performance.now() - started) * 10) / 10;
const round3 = (value: number) => Math.round(value * 1000) / 1000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let sampleRate = 0;
let samples = 0;
let onsetAudioS: number | null = null;
let firstFrameMs: number | null = null;
let micOffMs: number | null = null;
let maxPollGapMs = 0;
const segments: Segment[] = [];
const stt: Stt[] = [];
const runs: Run[] = [];
const seenTips = new Set<string>();
let marker: ReturnType<typeof createSegmenter> | null = null;
let reported = false;

function report(result: object): void {
  if (reported) return;
  reported = true;
  const state = getBeeState();
  const data = { sampleRate, onsetLevel: ONSET_LEVEL, onsetAudioS, firstFrameMs, micOffMs, maxPollGapMs, segments, stt, runs, seenTips: [...seenTips] };
  console.log(`E2E_RESULT ${JSON.stringify({ ...result, ...data, finalTips: state.result?.tips ?? [], storeError: state.error, micError: state.mic.error })}`);
}

const audioS = () => (sampleRate > 0 ? samples / sampleRate : 0);
const runOf = (id: number) => runs.find((item) => item.run === id);

function trackRuns(): void {
  for (let id = runs.length + 1; id <= runsStarted(); id += 1) runs.push({ run: id, startMs: now(), firstTextMs: null, firstText: [], finalTips: null });
}

function sawTips(run: Run | undefined, tips: string[]): void {
  for (const tip of tips) seenTips.add(tip);
  if (!run || run.firstTextMs !== null || tips.length === 0) return;
  run.firstTextMs = now();
  run.firstText = tips;
}

async function until(done: () => boolean, what: string): Promise<void> {
  while (!done()) {
    if (performance.now() - started > DEADLINE_MS) throw new Error(`${what} within ${DEADLINE_MS} ms of load`);
    await sleep(50);
  }
}

async function transcribe(audio: Uint8Array<ArrayBuffer>) {
  // 16 kHz 16-bit mono after a 44-byte header (speech.ts encodeWav).
  const call: Stt = { startMs: now(), endMs: null, audioS: round3((audio.length - 44) / 2 / 16_000), text: null, error: null };
  stt.push(call);
  try {
    const result = await window.bee.transcribe({ audio, sessionToken: token });
    call.text = result.text;
    call.error = result.error;
    return result;
  } catch (error) {
    call.error = String(error);
    throw error;
  } finally {
    call.endMs = now();
  }
}

function onFrame(frame: Float32Array, rate: number): void {
  if (!marker) {
    sampleRate = rate;
    firstFrameMs = now();
    marker = createSegmenter({
      sampleRate: rate,
      // Fires inside push(), so the audio clock is at the end of the frame that ended the phrase.
      onSpeechEnd: () => segments.push({ ms: now(), audioS: round3(audioS()), phraseS: 0 }),
      onPhrase: (phrase) => {
        const last = segments.at(-1);
        if (last) last.phraseS = round3(phrase.length / rate);
      },
    });
  }
  if (onsetAudioS === null) {
    const at = frame.findIndex((sample) => Math.abs(sample) >= ONSET_LEVEL);
    if (at >= 0) onsetAudioS = round3((samples + at) / rate);
  }
  samples += frame.length;
  marker.push(frame);
  if (micOffMs === null && onsetAudioS !== null && audioS() - onsetAudioS >= STOP_AFTER_ONSET_S) {
    micOffMs = now();
    actions.stopMic(null);
  }
}

async function run(): Promise<void> {
  // The store gets the same stream: each run's own tips, before the island merges them over kept ones.
  window.bee.onLunaPartial(({ runId, tips }) => {
    trackRuns();
    sawTips(runOf(runId === undefined ? runsStarted() : Number(runId)), tips);
  });
  let lastResult = getBeeState().result;
  let lastPoll = performance.now();
  // Runs start on the store's timers and results land in its state, so both are polled. The worst gap shows a throttled page.
  const poll = setInterval(() => {
    const at = performance.now();
    maxPollGapMs = Math.max(maxPollGapMs, Math.round(at - lastPoll));
    lastPoll = at;
    trackRuns();
    const result = getBeeState().result;
    if (result === lastResult) return;
    lastResult = result;
    if (!result) return;
    // The store keeps only the latest run's result.
    const latest = runOf(runsStarted());
    if (latest) latest.finalTips = result.tips;
    sawTips(latest, result.tips);
  }, POLL_MS);

  await startTestMicCapture({ transcribe, onFrame });
  const micError = getBeeState().mic.error;
  if (micError) throw new Error(micError);
  await until(() => micOffMs !== null, "The mic did not reach the end of the file");
  const settled = () => stt.every((call) => call.endMs !== null) && !getBeeState().busy && !getBeeState().heard;
  await until(settled, "The store did not settle after mic off");
  await sleep(QUIET_MS);
  await until(settled, "The store did not settle after the quiet wait");
  clearInterval(poll);
  trackRuns();
  report({ ok: true });
}

run().catch((error) => report({ ok: false, error: String(error) }));
