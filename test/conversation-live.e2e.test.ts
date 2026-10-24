import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { isMetaTip } from "../src/core/luna";
import { retrieve } from "../src/core/retrieve";
import { loadSnippets } from "../src/main/notes";
import { runHarnessWithOutput } from "./e2e/run";

// Live multi-turn Electron E2E (test/e2e/conversation-page.ts): the real store and island App, lines injected where speech-to-text
// hands them over with the mic on, then preload → main (meeting-ipc.ts) → live Gateway (Jev, and Luna on GUIDE_MODEL). No STT.
// One Electron launch, about five pipeline runs. Needs BEE_AI_GATEWAY_API_KEY; skipped otherwise. With BEE_E2E_SHOTS_DIR, the full
// text after turns 2 and 4 is written there as conversation-turn2-fulltext.png and conversation-turn4-fulltext.png.
// Run it with BEE_E2E_NOTES_DIR set to a folder holding one note unrelated to the questions (no London, Paris, news, weather,
// tube or percent): retrieval then finds nothing, so Jev is never called, and the test asserts that. Without it the harness
// seeds the sample notes and Jev may run.
// Vitest hides console output, so a markdown report is written before the assertions run (it exists on failure too): to
// BEE_CONVERSATION_REPORT (a file path) if set, else <BEE_E2E_SHOTS_DIR>/conversation-report.md.

// Each run is one Jev call at most and one or more Luna steps, so this keeps the scenario near 10 model calls (5 runs expected).
const MAX_RUNS = 6;
const FOLLOW_UP_MS = 15_000;
const PNG_MAGIC = "89504e470d0a1a0a";
const SHOTS = ["conversation-turn2-fulltext", "conversation-turn4-fulltext"];
// The model talking about its rules instead of answering ("The newest line asks…", "copy them word for word", "The limit is 3 tips").
const META_WORDS = /\b(?:tips?|newest line|word for word|limit is)\b/i;
const looksMeta = (tip: string) => isMetaTip(tip) || META_WORDS.test(tip);

const scrollSchema = z.object({ scrollTop: z.number(), scrollTopAfter2s: z.number(), scrollHeight: z.number(), clientHeight: z.number() });
const turnSchema = z.object({
  turn: z.number(),
  label: z.string(),
  injected: z.array(z.string()),
  tips: z.array(z.string()),
  sources: z.number(),
  latencyMs: z.number().nullable(),
  webTag: z.boolean(),
  runs: z.number(),
  keptMax: z.number(),
  revising: z.boolean(),
  error: z.string().nullable(),
  scroll: scrollSchema.nullable(),
  shotError: z.string().nullable(),
  checks: z.record(z.string(), z.boolean()),
  pass: z.boolean(),
});
type Turn = z.infer<typeof turnSchema>;
const reportSchema = z.object({ ok: z.boolean(), error: z.string().optional(), runs: z.number(), turns: z.array(turnSchema) });
const shotFileSchema = z.object({ file: z.string() });
// One "E2E_RUN {...}" line per pipeline run, from the harness's main process (harness-main.ts reportPipelineRuns).
const runLineSchema = z.object({ notes: z.number(), rankSource: z.enum(["jev", "fallback"]), rankMs: z.number(), jevCalled: z.boolean() });
type RunLine = z.infer<typeof runLineSchema>;

const prefixed = <T extends z.ZodType>(lines: string[], prefix: string, schema: T): z.infer<T>[] =>
  lines.filter((line) => line.startsWith(prefix)).map((line) => schema.parse(JSON.parse(line.slice(prefix.length))));

/** The page's checks plus the test's own: no tip in the turn reads as reasoning about the rules. */
function withMetaCheck(turn: Turn): Turn {
  const checks = { ...turn.checks, noMetaTips: !turn.tips.some(looksMeta) };
  return { ...turn, checks, pass: turn.pass && checks.noMetaTips };
}

const failed = (turn: Turn) => Object.keys(turn.checks).filter((name) => !turn.checks[name]);
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim() || "–";

function reportPath(): string | null {
  const file = process.env.BEE_CONVERSATION_REPORT?.trim();
  if (file) return file;
  const dir = process.env.BEE_E2E_SHOTS_DIR?.trim();
  return dir ? join(dir, "conversation-report.md") : null;
}

function writeReport(file: string, args: { ok: boolean; error?: string; runsStarted: number; runs: RunLine[]; turns: Turn[] }): void {
  const jevRuns = args.runs.filter((run) => run.jevCalled).length;
  const markdown = [
    "# Live conversation E2E report",
    "",
    `Written ${new Date().toISOString()}. Harness ${args.ok ? "finished" : `failed: ${cell(args.error ?? "unknown")}`}.`,
    "",
    "| Turn | Said | Came back | Latency ms | Sources | [web]? | Pass/Fail |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...args.turns.map((turn) =>
      [
        `${turn.turn} ${turn.label}`,
        cell(turn.injected.join(" → ") || "(mic off)"),
        cell(turn.tips.join(" / ") || "(no tips)") + (turn.error ? ` (error: ${cell(turn.error)})` : ""),
        turn.latencyMs ?? "–",
        turn.sources,
        turn.webTag ? "yes" : "no",
        (turn.pass ? "PASS" : `FAIL: ${failed(turn).join(", ")}`) + (turn.shotError ? ` (full text: ${cell(turn.shotError)})` : ""),
      ].join(" | "),
    ).map((row) => `| ${row} |`),
    "",
    `Total pipeline runs started: ${args.runsStarted} (max ${MAX_RUNS}). Runs returned to main: ${args.runs.length}.`,
    "",
    `Jev called: ${jevRuns > 0 ? `yes, in ${jevRuns} of ${args.runs.length} runs` : "no"}.`,
    "",
    "| Run | Notes retrieved | Rank source | Rank ms | Jev called |",
    "| --- | --- | --- | --- | --- |",
    ...args.runs.map((run, index) => `| ${index + 1} | ${run.notes} | ${run.rankSource} | ${run.rankMs} | ${run.jevCalled ? "yes" : "no"} |`),
    "",
  ].join("\n");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, markdown);
}

function printTurns(turns: Turn[]): void {
  console.table(
    turns.map((turn) => ({
      turn: `${turn.turn} ${turn.label}`,
      injected: turn.injected.join(" → ") || "(mic off)",
      "latency ms": turn.latencyMs ?? "–",
      tips: turn.tips.length,
      sources: turn.sources,
      "[web]": turn.webTag,
      runs: turn.runs,
      kept: turn.keptMax,
      revising: turn.revising,
      "scroll 0/2s": turn.scroll ? `${turn.scroll.scrollTop}/${turn.scroll.scrollTopAfter2s} of ${turn.scroll.scrollHeight - turn.scroll.clientHeight}` : "–",
      pass: turn.pass ? "PASS" : `FAIL: ${Object.keys(turn.checks).filter((name) => !turn.checks[name]).join(", ")}`,
    })),
  );
  for (const turn of turns) {
    console.log(`Turn ${turn.turn} (${turn.label})${turn.error ? ` error: ${turn.error}` : ""}${turn.shotError ? ` full text: ${turn.shotError}` : ""}\n${turn.tips.map((tip) => `  - ${tip}`).join("\n") || "  (no tips)"}`);
  }
}

describe.skipIf(!process.env.BEE_AI_GATEWAY_API_KEY?.trim())("live multi-turn conversation (Electron E2E)", () => {
  it("answers a follow-up with the mic on, starts afresh on a new subject, steers, and stays quiet after mic off", { timeout: 250_000 }, async () => {
    const { report: raw, lines } = await runHarnessWithOutput({ page: "conversation-page", env: {}, report: reportSchema, timeoutMs: 240_000 });
    const report = { ...raw, turns: raw.turns.map(withMetaCheck) };
    const runs = prefixed(lines, "E2E_RUN ", runLineSchema);
    const file = reportPath();
    if (file) writeReport(file, { ok: report.ok, error: report.error, runsStarted: report.runs, runs, turns: report.turns });
    printTurns(report.turns);
    console.log(`Pipeline runs started: ${report.runs} (max ${MAX_RUNS}). Jev called in ${runs.filter((run) => run.jevCalled).length} of ${runs.length} runs.`);
    if (file) console.log(`Report: ${file}`);
    if (!report.ok) throw new Error(`E2E failed: ${report.error ?? "unknown"}`);

    const turn = (n: number) => turnSchema.parse(report.turns.find((item) => item.turn === n));
    expect(report.turns.map((item) => item.turn)).toEqual([1, 2, 3, 4, 5]);
    for (const item of report.turns) expect(item.webTag, `turn ${item.turn} shows [web]`).toBe(false);
    expect(report.runs).toBeLessThanOrEqual(MAX_RUNS);
    for (const item of report.turns) {
      expect(item.tips.filter(looksMeta), `turn ${item.turn} shows reasoning about the rules, not a tip`).toEqual([]);
    }
    expect(runs.length, "every run started returns to main").toBe(report.runs);

    const notesDir = process.env.BEE_E2E_NOTES_DIR?.trim();
    if (notesDir) {
      // Every query is drawn from the lines said, so if all of them together retrieve nothing, no run can.
      const said = report.turns.flatMap((item) => item.injected).join(" ");
      expect(retrieve(said, loadSnippets(notesDir)), "BEE_E2E_NOTES_DIR must hold only notes unrelated to the questions").toEqual([]);
      expect(runs.filter((run) => run.jevCalled), "Jev was called").toEqual([]);
    }

    const followUp = turn(2);
    expect(followUp.latencyMs).toBeLessThan(FOLLOW_UP_MS);
    expect(followUp.checks).toMatchObject({ answered: true, givesReason: true, micOn: true });

    expect(turn(3).checks).toMatchObject({ answered: true, notRevising: true, noStaleTips: true });
    expect(turn(4).checks).toMatchObject({ answered: true, steerWhileBusy: true, steered: true, redirected: true, noEarlierTips: true, noMetaTips: true });
    expect(turn(5).checks).toMatchObject({ micOff: true, noLateRun: true, noLateAnswer: true });

    const files = lines.filter((line) => line.startsWith("E2E_SHOT_FILE ")).map((line) => shotFileSchema.parse(JSON.parse(line.slice("E2E_SHOT_FILE ".length))).file);
    if (!process.env.BEE_E2E_SHOTS_DIR) return;
    console.log(`Screenshots:\n${files.join("\n")}`);
    for (const n of [2, 4]) expect(turn(n).shotError, `turn ${n} full-text shot`).toBeNull();
    expect(files.map((file) => file.split(/[\\/]/).pop())).toEqual(SHOTS.map((name) => `${name}.png`));
    for (const file of files) expect(readFileSync(file).subarray(0, 8).toString("hex")).toBe(PNG_MAGIC);
    for (const n of [2, 4]) expect(turn(n).checks.fullTextAtTop, `turn ${n} full text opens and stays at the top`).toBe(true);
  });
});
