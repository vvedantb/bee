// Runs in the harness renderer for the live conversation test: the real store (src/renderer/src/store.ts) and island App. The mic
// is on as startTestMic, so each line goes in where speech-to-text hands it over, then preload → main (meeting-ipc.ts) → live
// Gateway. No STT call is made. Five turns, with an E2E_MARK line at each injection and settle. Reports once.
// With ?shots=1 the full text is opened after turns 2 and 4 and the harness captures the window (E2E_SHOT).
import { StrictMode, createElement } from "react";
import { createRoot } from "react-dom/client";
import { tipKey } from "../../src/core/steering";
import { App } from "../../src/renderer/src/App";
import { actions, displayResult, getBeeState, runsStarted, startTestMic } from "../../src/renderer/src/store";
import "../../src/renderer/src/styles.css";

const LINES = {
  news: "what's in the news in London today",
  why: "why are there tube closures",
  unrelated: "what is fifteen percent of eighteen thousand",
  ask: "what's the weather forecast for London this weekend",
  steer: "actually make that for Paris instead",
};

// A turn that never settles fails the run here, well inside the harness timeout.
const SETTLE_MS = 60_000;
const FOLLOW_UP_MS = 15_000;
// The steer line comes while the question's run is still busy.
const STEER_AFTER_MS = 1_000;
// After mic off, nothing may start or land for this long.
const QUIET_MS = 10_000;
const SAMPLE_MS = 20;
// The full text is captured once its open has painted, and its scroll read again 2 s after opening.
const SHOT_AFTER_MS = 500;
const RECHECK_MS = 2_000;
// The follow-up must say why, not only list closures.
const REASON = /\b(because|due to|caused by|as a result|owing to|so that|to (allow|carry out|upgrade|replace|repair)|engineering|maintenance|upgrad\w*|strikes?|industrial action|works)\b/i;
const WEB_TAG = /\[web\]/i;

type Scroll = { scrollTop: number; scrollTopAfter2s: number; scrollHeight: number; clientHeight: number };
type Turn = {
  turn: number;
  label: string;
  injected: string[];
  tips: string[];
  sources: number;
  latencyMs: number | null;
  webTag: boolean;
  // Runs started in the turn, and while busy: the most tips kept on screen (dimmed) and whether the pill was "Updating…".
  runs: number;
  keptMax: number;
  revising: boolean;
  error: string | null;
  scroll: Scroll | null;
  checks: Record<string, boolean>;
  pass: boolean;
};

const shots = new URLSearchParams(location.search).get("shots") === "1";
const turns: Turn[] = [];
const started = performance.now();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function mark(data: object): void {
  console.log(`E2E_MARK ${JSON.stringify({ t: Math.round(performance.now() - started), at: new Date().toISOString(), ...data })}`);
}

/** Samples the store every SAMPLE_MS until stop(): every tip the island showed (streamed or final) and the steering state while busy. */
function watch() {
  const seen = new Set<string>();
  let keptMax = 0;
  let revising = false;
  let busy = false;
  const sample = () => {
    const state = getBeeState();
    for (const tip of displayResult(state)?.tips ?? []) seen.add(tip);
    if (!state.busy) return;
    busy = true;
    keptMax = Math.max(keptMax, state.keptTips.length);
    revising ||= state.revising;
  };
  sample();
  const timer = setInterval(sample, SAMPLE_MS);
  return {
    stop: () => {
      clearInterval(timer);
      sample();
      return { seen: [...seen], keptMax, revising, busy };
    },
  };
}

async function until(done: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const end = performance.now() + timeoutMs;
  while (!done()) {
    if (performance.now() > end) throw new Error(`${what} within ${timeoutMs} ms`);
    await sleep(SAMPLE_MS);
  }
}

/**
 * One conversational turn: the line goes in (and the steer line after its delay), then it waits for the answer to settle. The
 * watch starts after the first line, when a fresh turn has already cleared the last answer.
 */
async function converse(turn: number, label: string, say: (text: string) => void, text: string, steer?: { text: string; afterMs: number }) {
  const runsBefore = runsStarted();
  const from = performance.now();
  const busyAtLine: boolean[] = [];
  const inject = (line: string) => {
    busyAtLine.push(getBeeState().busy);
    mark({ turn, event: "inject", text: line, busy: getBeeState().busy });
    say(line);
  };
  inject(text);
  const watching = watch();
  if (steer) {
    await sleep(steer.afterMs);
    inject(steer.text);
  }
  await until(() => !getBeeState().busy && !getBeeState().heard, SETTLE_MS, `Turn ${turn} did not settle`);
  const latencyMs = Math.round(performance.now() - from);
  const seen = watching.stop();
  const state = getBeeState();
  const tips = state.result?.tips ?? [];
  const runs = runsStarted() - runsBefore;
  mark({ turn, event: "settled", latencyMs, tips: tips.length, runs });
  const record: Turn = {
    turn,
    label,
    injected: steer ? [text, steer.text] : [text],
    tips,
    sources: state.result?.sources.length ?? 0,
    latencyMs,
    webTag: [...seen.seen, ...tips].some((tip) => WEB_TAG.test(tip)),
    runs,
    keptMax: seen.keptMax,
    revising: seen.revising,
    error: state.result?.guideError ?? state.error,
    scroll: null,
    checks: {},
    pass: false,
  };
  return { record, seen: seen.seen, busyAtLine };
}

function finish(record: Turn, checks: Record<string, boolean>): Turn {
  const done = { ...record, checks, pass: Object.values(checks).every(Boolean) };
  turns.push(done);
  return done;
}

const answered = (record: Turn) => ({ answered: record.tips.length > 0 && record.error === null, noWebTag: !record.webTag });

/**
 * Folds the body to the pill's one line (as when the user reads on), opens the answer in full with the store action, and has the
 * harness capture the window. The full text must open at the top and stay there.
 */
async function fullTextShot(name: string): Promise<Scroll | null> {
  if (!shots) return null;
  await actions.dismissIsland();
  await until(() => document.querySelector(".island-scroll") === null, 2_000, "The island body did not fold");
  actions.openFullText();
  await until(() => document.querySelector(".island-scroll") !== null, 2_000, "The full text did not open");
  const scroller = document.querySelector<HTMLElement>(".island-scroll");
  if (!scroller) throw new Error("No .island-scroll");
  const scrollTop = scroller.scrollTop;
  await sleep(SHOT_AFTER_MS);
  console.log(`E2E_SHOT ${JSON.stringify({ name })}`);
  await sleep(RECHECK_MS - SHOT_AFTER_MS);
  return { scrollTop, scrollTopAfter2s: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight };
}

const atTop = (scroll: Scroll | null): Record<string, boolean> =>
  scroll ? { fullTextAtTop: scroll.scrollTop === 0 && scroll.scrollTopAfter2s === 0 } : {};

async function run(): Promise<void> {
  const say = startTestMic().phrase;

  const t1 = await converse(1, "news", say, LINES.news);
  finish(t1.record, answered(t1.record));

  // Straight after the answer, mic still on: a follow-up question needs no mic off to be answered.
  const t2 = await converse(2, "follow-up", say, LINES.why);
  const shot2 = await fullTextShot("conversation-turn2-fulltext");
  const turn2 = finish(
    { ...t2.record, scroll: shot2 },
    {
      ...answered(t2.record),
      under15s: (t2.record.latencyMs ?? Infinity) < FOLLOW_UP_MS,
      givesReason: REASON.test(t2.record.tips.join(" ")),
      micOn: getBeeState().mic.on,
      ...atTop(shot2),
    },
  );

  // A new subject after the answer settled: a fresh turn, so the last answer is neither kept nor shown.
  const t3 = await converse(3, "unrelated", say, LINES.unrelated);
  const before = new Set(turn2.tips.map(tipKey));
  finish(t3.record, {
    ...answered(t3.record),
    notRevising: !t3.record.revising && t3.record.keptMax === 0,
    noStaleTips: !t3.seen.some((tip) => before.has(tipKey(tip))),
  });

  // A steer while the question is still running: the tips so far stay (dimmed) and the answer is redirected.
  const t4 = await converse(4, "steer", say, LINES.ask, { text: LINES.steer, afterMs: STEER_AFTER_MS });
  const shot4 = await fullTextShot("conversation-turn4-fulltext");
  finish(
    { ...t4.record, scroll: shot4 },
    {
      ...answered(t4.record),
      steerWhileBusy: t4.busyAtLine[1] === true,
      steered: t4.record.revising && t4.record.keptMax > 0,
      redirected: /paris/i.test(t4.record.tips.join(" ")),
      ...atTop(shot4),
    },
  );

  // Mic off: no late run, and nothing replaces the last answer.
  const runsBefore = runsStarted();
  const last = getBeeState().result;
  mark({ turn: 5, event: "mic-off" });
  actions.stopMic(null);
  const quiet = watch();
  await sleep(QUIET_MS);
  const after = quiet.stop();
  const state = getBeeState();
  const runs = runsStarted() - runsBefore;
  mark({ turn: 5, event: "quiet", runs, busy: after.busy });
  finish(
    {
      turn: 5,
      label: "mic off",
      injected: [],
      tips: state.result?.tips ?? [],
      sources: state.result?.sources.length ?? 0,
      latencyMs: null,
      webTag: after.seen.some((tip) => WEB_TAG.test(tip)),
      runs,
      keptMax: after.keptMax,
      revising: after.revising,
      error: state.error,
      scroll: null,
      checks: {},
      pass: false,
    },
    { micOff: !state.mic.on, noLateRun: runs === 0 && !after.busy, noLateAnswer: state.result === last },
  );

  report({ ok: true });
}

function report(result: { ok: true } | { ok: false; error: string }): void {
  console.log(`E2E_RESULT ${JSON.stringify({ ...result, runs: runsStarted(), turns })}`);
}

window.addEventListener("DOMContentLoaded", () => {
  // As index.html: dark mode, and the app in #root.
  document.documentElement.classList.add("dark");
  document.body.insertAdjacentHTML("beforeend", '<div id="root"></div>');
  // Offscreen Electron windows may not advance CSS animations; captures show the settled end state (as island-shots.ts).
  document.head.insertAdjacentHTML("beforeend", "<style>*, *::before, *::after { animation: none !important; transition: none !important; }</style>");
  const root = document.getElementById("root");
  if (root) createRoot(root).render(createElement(StrictMode, null, createElement(App)));
  run().catch((error) => report({ ok: false, error: String(error) }));
});
