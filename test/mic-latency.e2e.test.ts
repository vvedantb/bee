import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { retrieve } from "../src/core/retrieve";
import { tipKey } from "../src/core/steering";
import { END_SILENCE_MS } from "../src/renderer/src/speech";
import { loadSnippets } from "../src/main/notes";
import { root, runHarnessWithOutput } from "./e2e/run";
import { readWav, speechSpans } from "./helpers/wav";

// Live real-mic Electron E2E with latency (test/e2e/mic-latency-page.ts): Chromium's fake device plays
// test/fixtures/london-tube-question.wav into the store's real mic → segmenter → Grok STT in main → simulateLine → pipeline →
// live Gateway, with the mic on for the follow-up. Per line it reports end-of-speech detection delay, end of speech → transcript
// and transcript → first answer text, and counts STT calls, pipeline runs and Jev calls.
// Opt-in, as it costs money: runs only with BEE_E2E_LIVE_MIC=1 and BEE_AI_GATEWAY_API_KEY. Never in CI (the unit config does
// not include e2e files). The notes folder holds one unrelated note, so Jev is never called (BEE_E2E_NOTES_DIR overrides it).
// The report is printed and, with BEE_MIC_REPORT (a .md path), written there with the raw page data beside it as .json,
// before the assertions run.

const AUDIO = `${root}test/fixtures/london-tube-question.wav`;
// Each line's transcript must match every pattern in `expect`, so a garbled line fails. Where its speech ends is measured from
// the file (FILE_SPEECH), as espeak-ng ends each phrase with about 0.5 s of near-silence.
const LINES = [
  { label: "news", expect: [/london|news/i], notExpect: /tube|closure/i },
  { label: "follow-up", expect: [/tube/i, /closure/i], notExpect: /london|news/i },
];
// A sample at or above this is speech; a quieter gap this long separates lines.
const FILE_SPEECH = { level: 0.001, gapS: 0.5 };
const MAX_STT = 4;
const MAX_RUNS = 3;
const WEB_TAG = /\[web\]/i;
const UNRELATED_NOTE = "# Garden\n\nWater the tomato plants every morning and feed them once a fortnight.\n";

const segmentSchema = z.object({ ms: z.number(), audioS: z.number(), phraseS: z.number() });
const sttSchema = z.object({ startMs: z.number(), endMs: z.number().nullable(), audioS: z.number(), text: z.string().nullable(), error: z.string().nullable() });
const runSchema = z.object({ run: z.number(), startMs: z.number(), kept: z.array(z.string()), firstTextMs: z.number().nullable(), firstText: z.array(z.string()), finalTips: z.array(z.string()).nullable() });
const reportSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  sampleRate: z.number(),
  onsetLevel: z.number(),
  stopAfterOnsetS: z.number(),
  onsetAudioS: z.number().nullable(),
  firstFrameMs: z.number().nullable(),
  micOffMs: z.number().nullable(),
  segments: z.array(segmentSchema),
  stt: z.array(sttSchema),
  runs: z.array(runSchema),
  seenTips: z.array(z.string()),
  finalTips: z.array(z.string()),
  storeError: z.string().nullable(),
  micError: z.string().nullable(),
});
type Report = z.infer<typeof reportSchema>;
type Run = z.infer<typeof runSchema>;
// One "E2E_RUN {...}" line per pipeline run that returns, from harness-main.ts reportPipelineRuns.
const runLineSchema = z.object({ notes: z.number(), rankSource: z.enum(["jev", "fallback"]), rankMs: z.number(), jevCalled: z.boolean() });
type RunLine = z.infer<typeof runLineSchema>;
type Wav = ReturnType<typeof readWav>;

/** Seconds into the file of the first sample at or above `level`. */
function fileOnsetS(wav: Wav, level: number): number {
  const at = wav.samples.findIndex((sample) => Math.abs(sample) >= level);
  if (at < 0) throw new Error(`No sample at or above ${level} in ${AUDIO}`);
  return at / wav.rate;
}

const ms = (value: number | null) => (value === null ? null : Math.round(value));
const cell = (value: string | number | null) => (value === null ? "–" : String(value).replace(/\|/g, "\\|").replace(/\s+/g, " ").trim() || "–");

/** Per line: segment i, STT call i, and the runs started after its transcript and before the next one. */
function analyse(report: Report, onsetS: number, speechEndsS: number[]) {
  // Audio clock → seconds into the file, by matching the first speech the page heard with the file's.
  const offsetS = report.onsetAudioS === null ? null : onsetS - report.onsetAudioS;
  const earlierKeys = new Set<string>();
  const lines = LINES.map((line, index) => {
    const speechEndS = Math.round((speechEndsS[index] ?? NaN) * 1000) / 1000;
    const segment = report.segments[index] ?? null;
    const stt = report.stt[index] ?? null;
    const sttEnd = stt?.endMs ?? null;
    const nextEnd = report.stt[index + 1]?.endMs ?? Infinity;
    const runs = sttEnd === null ? [] : report.runs.filter((run) => run.startMs >= sttEnd && run.startMs < nextEnd);
    const first = runs.reduce<Run | null>((best, run) => (run.firstTextMs !== null && (best?.firstTextMs ?? Infinity) > run.firstTextMs ? run : best), null);
    const firstMs = first?.firstTextMs ?? null;
    const tips = [...new Set(runs.flatMap((run) => [...run.firstText, ...(run.finalTips ?? [])]))];
    // Tips kept from an earlier line (steering) are not this line's answer.
    const newTips = tips.filter((tip) => !earlierKeys.has(tipKey(tip)));
    for (const tip of tips) earlierKeys.add(tipKey(tip));
    const detectedS = segment && offsetS !== null ? segment.audioS + offsetS : null;
    const detectionDelayMs = detectedS === null ? null : (detectedS - speechEndS) * 1000;
    const detectToTranscriptMs = segment && sttEnd !== null ? sttEnd - segment.ms : null;
    const transcript = stt?.text ?? null;
    return {
      label: line.label,
      speechEndS,
      detectedS: detectedS === null ? null : Math.round(detectedS * 1000) / 1000,
      detectionDelayMs: ms(detectionDelayMs),
      phraseS: segment?.phraseS ?? null,
      detectToSttStartMs: segment && stt ? ms(stt.startMs - segment.ms) : null,
      sttMs: stt && sttEnd !== null ? ms(sttEnd - stt.startMs) : null,
      detectToTranscriptMs: ms(detectToTranscriptMs),
      speechEndToTranscriptMs: detectionDelayMs === null || detectToTranscriptMs === null ? null : ms(detectionDelayMs + detectToTranscriptMs),
      transcript,
      sttError: stt?.error ?? null,
      runs: runs.map((run) => run.run),
      transcriptToRunStartMs: sttEnd !== null && runs[0] ? ms(runs[0].startMs - sttEnd) : null,
      transcriptToFirstAnswerMs: sttEnd !== null && firstMs !== null ? ms(firstMs - sttEnd) : null,
      firstAnswer: first?.firstText ?? [],
      newTips,
      // Every expected word: a line heard only in part ("While at you, closures.") is not heard.
      heard: line.expect.every((pattern) => pattern.test(transcript ?? "")),
      // Words of the other line in this transcript: two lines merged, or a cut in the wrong place.
      mixed: line.notExpect.test(transcript ?? ""),
    };
  });
  return { offsetS, lines };
}

function markdown(args: { report: Report; onsetS: number; analysis: ReturnType<typeof analyse>; runLines: RunLine[]; notesDir: string }): string {
  const { report, onsetS, analysis, runLines } = args;
  const jevRuns = runLines.filter((run) => run.jevCalled).length;
  const missed = analysis.lines.filter((line) => !line.heard).map((line) => `${line.label} "${line.transcript ?? ""}"`);
  return [
    "# Live mic latency E2E report",
    "",
    `Written ${new Date().toISOString()}. Harness ${report.ok ? "finished" : `failed: ${cell(report.error ?? "unknown")}`}. Fixture: test/fixtures/london-tube-question.wav.`,
    "",
    `Capture ${report.sampleRate} Hz. Clocks aligned on the first sample ≥ ${report.onsetLevel}: ${onsetS.toFixed(3)} s into the file, ${report.onsetAudioS?.toFixed(3) ?? "–"} s on the audio clock (offset ${analysis.offsetS?.toFixed(3) ?? "–"} s). ` +
      `Speech ends are measured from the file: the last sample ≥ ${FILE_SPEECH.level} before ${FILE_SPEECH.gapS} s of quiet. Detection is the end of the frame that ended the phrase, so it includes up to one frame. ` +
      "Run starts and results are timed from the store's state changes. A run's first answer is its first tip not kept from the screen.",
    "",
    "| Line | Speech end s | Detected s | Detection delay ms | Detected → STT start ms | STT ms | Detected → transcript ms | Speech end → transcript ms | Transcript → run start ms | Transcript → first answer ms |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...analysis.lines.map((line, index) =>
      `| ${index + 1} ${line.label} | ${line.speechEndS} | ${cell(line.detectedS)} | ${cell(line.detectionDelayMs)} | ${cell(line.detectToSttStartMs)} | ${cell(line.sttMs)} | ${cell(line.detectToTranscriptMs)} | ${cell(line.speechEndToTranscriptMs)} | ${cell(line.transcriptToRunStartMs)} | ${cell(line.transcriptToFirstAnswerMs)} |`,
    ),
    "",
    "| Line | Transcript | Runs | First answer text | New tips | Pass |",
    "| --- | --- | --- | --- | --- | --- |",
    ...analysis.lines.map((line, index) =>
      `| ${index + 1} ${line.label} | ${cell(line.transcript ?? `(none${line.sttError ? `: ${line.sttError}` : ""})`)} | ${cell(line.runs.join(", "))} | ${cell(line.firstAnswer.join(" / "))} | ${line.newTips.length} | ${line.heard && !line.mixed && line.newTips.length > 0 ? "PASS" : "FAIL"} |`,
    ),
    "",
    `Lines heard in full: ${LINES.length - missed.length} of ${LINES.length}${missed.length > 0 ? ` (not: ${missed.join(", ")})` : ""}. Segments detected: ${report.segments.length}. STT calls: ${report.stt.length} (max ${MAX_STT}). Pipeline runs started: ${report.runs.length} (max ${MAX_RUNS}); returned to main: ${runLines.length}.`,
    "",
    `Jev called: ${jevRuns > 0 ? `yes, in ${jevRuns} of ${runLines.length} runs` : "no"}. Notes folder: ${args.notesDir}.`,
    "",
    `Final answer: ${cell(report.finalTips.join(" / ") || "(none)")}. [web] tag seen: ${report.seenTips.some((tip) => WEB_TAG.test(tip)) ? "yes" : "no"}.` +
      (report.storeError ? ` Store error: ${cell(report.storeError)}.` : "") +
      (report.micError ? ` Mic error: ${cell(report.micError)}.` : ""),
    "",
  ].join("\n");
}

const live = process.env.BEE_E2E_LIVE_MIC === "1" && Boolean(process.env.BEE_AI_GATEWAY_API_KEY?.trim());

describe.skipIf(!live)("live mic latency: fake mic → segmenter → Grok STT → pipeline (Electron E2E)", () => {
  it("transcribes and answers both lines, with the mic on for the follow-up, and reports each stage's latency", { timeout: 170_000 }, async () => {
    const notesDir = process.env.BEE_E2E_NOTES_DIR?.trim() || join(mkdtempSync(join(tmpdir(), "bee-mic-latency-")), "notes");
    mkdirSync(notesDir, { recursive: true });
    if (!process.env.BEE_E2E_NOTES_DIR?.trim()) writeFileSync(join(notesDir, "garden.md"), UNRELATED_NOTE);

    const { report, lines } = await runHarnessWithOutput({ page: "mic-latency-page", env: { BEE_E2E_AUDIO: AUDIO, BEE_E2E_NOTES_DIR: notesDir }, report: reportSchema, timeoutMs: 150_000 });
    const runLines = lines.filter((line) => line.startsWith("E2E_RUN ")).map((line) => runLineSchema.parse(JSON.parse(line.slice("E2E_RUN ".length))));
    const wav = readWav(AUDIO);
    const onsetS = fileOnsetS(wav, report.onsetLevel);
    const speechEndsS = speechSpans(wav, FILE_SPEECH.level, FILE_SPEECH.gapS).map((span) => span.end);
    const analysis = analyse(report, onsetS, speechEndsS);
    const text = markdown({ report, onsetS, analysis, runLines, notesDir });
    const file = process.env.BEE_MIC_REPORT?.trim();
    if (file) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
      writeFileSync(file.replace(/\.md$/i, "") + ".json", JSON.stringify({ report, onsetS, analysis, runLines }, null, 2));
    }
    console.log(text);
    if (file) console.log(`Report: ${file}`);
    if (!report.ok) throw new Error(`E2E failed: ${report.error ?? "unknown"}`);

    // The page's mic-off point, in seconds into the file: after the last line is detected, before the fake device loops.
    const micOffS = onsetS + report.stopAfterOnsetS;
    expect(micOffS, "mic off after the last line is detected").toBeGreaterThan((speechEndsS.at(-1) ?? Infinity) + END_SILENCE_MS / 1000);
    expect(micOffS, "mic off before the fake device loops the file").toBeLessThan(wav.samples.length / wav.rate);
    expect(report.micError).toBeNull();
    expect(report.segments.length, "one segment per line: none dropped, none merged or split").toBe(LINES.length);
    expect(report.stt.map((call) => call.error)).toEqual(LINES.map(() => null));
    for (const [index, line] of analysis.lines.entries()) {
      expect(line.heard, `line ${index + 1} transcript: ${line.transcript}`).toBe(true);
      expect(line.mixed, `line ${index + 1} holds the other line's words: ${line.transcript}`).toBe(false);
      expect(line.runs.length, `line ${index + 1} started a run`).toBeGreaterThan(0);
      expect(line.newTips.length, `line ${index + 1} got an answer of its own`).toBeGreaterThan(0);
    }
    expect(report.seenTips.filter((tip) => WEB_TAG.test(tip)), "tips with a [web] tag").toEqual([]);
    expect(report.stt.length).toBeLessThanOrEqual(MAX_STT);
    expect(report.runs.length).toBeLessThanOrEqual(MAX_RUNS);
    expect(runLines.length, "every run started returns to main").toBe(report.runs.length);
    if (!process.env.BEE_E2E_NOTES_DIR?.trim()) {
      const said = analysis.lines.map((line) => line.transcript ?? "").join(" ");
      expect(retrieve(said, loadSnippets(notesDir)), "the unrelated note matched the transcripts").toEqual([]);
      expect(runLines.filter((run) => run.jevCalled), "Jev was called").toEqual([]);
    }
  });
});
