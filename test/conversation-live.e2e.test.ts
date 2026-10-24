import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runHarnessWithOutput } from "./e2e/run";

// Live multi-turn Electron E2E (test/e2e/conversation-page.ts): the real store and island App, lines injected where speech-to-text
// hands them over with the mic on, then preload → main (meeting-ipc.ts) → live Gateway (Jev, and Luna on GUIDE_MODEL). No STT.
// One Electron launch, about five pipeline runs. Needs BEE_AI_GATEWAY_API_KEY; skipped otherwise. With BEE_E2E_SHOTS_DIR, the full
// text after turns 2 and 4 is written there as conversation-turn2-fulltext.png and conversation-turn4-fulltext.png.

// Each run is one Jev call and one or more Luna steps, so this keeps the scenario near 10 model calls (5 runs expected).
const MAX_RUNS = 6;
const FOLLOW_UP_MS = 15_000;
const PNG_MAGIC = "89504e470d0a1a0a";
const SHOTS = ["conversation-turn2-fulltext", "conversation-turn4-fulltext"];

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
  checks: z.record(z.string(), z.boolean()),
  pass: z.boolean(),
});
type Turn = z.infer<typeof turnSchema>;
const reportSchema = z.object({ ok: z.boolean(), error: z.string().optional(), runs: z.number(), turns: z.array(turnSchema) });
const shotFileSchema = z.object({ file: z.string() });

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
    console.log(`Turn ${turn.turn} (${turn.label})${turn.error ? ` error: ${turn.error}` : ""}\n${turn.tips.map((tip) => `  - ${tip}`).join("\n") || "  (no tips)"}`);
  }
}

describe.skipIf(!process.env.BEE_AI_GATEWAY_API_KEY?.trim())("live multi-turn conversation (Electron E2E)", () => {
  it("answers a follow-up with the mic on, starts afresh on a new subject, steers, and stays quiet after mic off", { timeout: 250_000 }, async () => {
    const { report, lines } = await runHarnessWithOutput({ page: "conversation-page", env: {}, report: reportSchema, timeoutMs: 240_000 });
    printTurns(report.turns);
    console.log(`Pipeline runs started: ${report.runs} (max ${MAX_RUNS})`);
    if (!report.ok) throw new Error(`E2E failed: ${report.error ?? "unknown"}`);

    const turn = (n: number) => turnSchema.parse(report.turns.find((item) => item.turn === n));
    expect(report.turns.map((item) => item.turn)).toEqual([1, 2, 3, 4, 5]);
    for (const item of report.turns) expect(item.webTag, `turn ${item.turn} shows [web]`).toBe(false);
    expect(report.runs).toBeLessThanOrEqual(MAX_RUNS);

    const followUp = turn(2);
    expect(followUp.latencyMs).toBeLessThan(FOLLOW_UP_MS);
    expect(followUp.checks).toMatchObject({ answered: true, givesReason: true, micOn: true });

    expect(turn(3).checks).toMatchObject({ answered: true, notRevising: true, noStaleTips: true });
    expect(turn(4).checks).toMatchObject({ answered: true, steerWhileBusy: true, steered: true, redirected: true });
    expect(turn(5).checks).toMatchObject({ micOff: true, noLateRun: true, noLateAnswer: true });

    const files = lines.filter((line) => line.startsWith("E2E_SHOT_FILE ")).map((line) => shotFileSchema.parse(JSON.parse(line.slice("E2E_SHOT_FILE ".length))).file);
    if (!process.env.BEE_E2E_SHOTS_DIR) return;
    console.log(`Screenshots:\n${files.join("\n")}`);
    expect(files.map((file) => file.split(/[\\/]/).pop())).toEqual(SHOTS.map((name) => `${name}.png`));
    for (const file of files) expect(readFileSync(file).subarray(0, 8).toString("hex")).toBe(PNG_MAGIC);
    for (const n of [2, 4]) expect(turn(n).checks.fullTextAtTop, `turn ${n} full text opens and stays at the top`).toBe(true);
  });
});
