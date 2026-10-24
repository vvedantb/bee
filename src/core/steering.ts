import { tokenize } from "./retrieve";

// Pure rules for live steering: a new line while Bee answers. No React, window or timers here, so tests can call them.

/** Visible tips: 2 for a fresh turn, 3 while a steering burst keeps earlier tips on screen. */
export const MAX_TIPS = 2;
export const MAX_STEERING_TIPS = 3;

/** After a new line, wait this long for another phrase before the run starts. */
export const DEBOUNCE_MS = 500;
/** This many restarts inside RESTART_WINDOW_MS make the next run wait for PAUSE_MS of quiet. */
export const MAX_RESTARTS = 3;
export const RESTART_WINDOW_MS = 10_000;
export const PAUSE_MS = 1_500;

/** True when the line has no content words ("yeah", "okay", "um"). Such a line joins the transcript but never starts or aborts a run. */
export function isFiller(line: string): boolean {
  return tokenize(line).length === 0;
}

// Speech-to-text often drops the "?", so a line that opens like a question counts too.
const QUESTION_START =
  /^(?:(?:so|and|but|okay|ok|hey|right|well|then)[\s,]+)*(?:(?:what|what's|whats|why|how|how's|when|where|who|whom|whose|which|explain|tell me)\b|(?:is|are|was|were|does|did|can|could|will|would|should|has|have)\s+(?:i|you|we|they|he|she|it|there|this|that|these|those|the|any)\b|do\s+(?:i|you|we|they)\b)/i;

/** True when the line asks something directly: it ends with "?" or opens like a question ("why are there tube closures"). */
export function isQuestion(line: string): boolean {
  const text = line.trim();
  return text.endsWith("?") || QUESTION_START.test(text);
}

/** A tip's identity: trimmed, note cites ([n1], [web]) removed, spaces collapsed. */
export function tipKey(tip: string): string {
  return tip
    .replace(/\[(?:n\d+|web)\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The tip lists' cap: 3 while earlier tips are kept (a steering burst), else 2. */
export function tipCap(keptCount: number): number {
  return keptCount > 0 ? MAX_STEERING_TIPS : MAX_TIPS;
}

/**
 * The tips to show from the tips kept on screen and a run's tips, matched by tipKey. The run returns the full set, so on a
 * final merge a kept tip it left out has been replaced and goes. Kept tips keep their place and their exact text, so an equal
 * tip is a no-op. New tips follow. While the run still streams (final false), kept tips not yet repeated stay, but give way to
 * new ones when the cap is full. A final run with no tips (NONE, or an error) leaves the kept tips as they are.
 */
export function mergeTips(
  kept: readonly string[],
  incoming: readonly string[],
  max = tipCap(kept.length),
  final = true,
): string[] {
  const keptKeys = kept.map(tipKey);
  const seen = new Set<string>();
  const fresh = incoming.filter((tip) => {
    const key = tipKey(tip);
    if (key === "" || keptKeys.includes(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const incomingKeys = new Set(incoming.map(tipKey));
  if (final && incomingKeys.size === 0) return kept.slice(0, max);
  const entries = [
    ...kept.map((tip, index) => ({
      tip,
      leftover: !incomingKeys.has(keptKeys[index] as string),
    })),
    ...fresh.map((tip) => ({ tip, leftover: false })),
  ].filter((entry) => !(final && entry.leftover));
  // Over the cap: kept tips the run has not repeated go first, from the end.
  while (entries.length > max) {
    const at = entries.map((entry) => entry.leftover).lastIndexOf(true);
    entries.splice(at === -1 ? entries.length - 1 : at, 1);
  }
  return entries.map((entry) => entry.tip);
}

/** A run that has its first tip complete and is on its second is nearly done: let it finish. runTips: the tips it streamed so far. */
export function inCommitWindow(runTips: number): boolean {
  return runTips >= 2;
}

/**
 * Whether a line that steers waits for the run in flight to finish instead of cancelling it. A new turn never waits. A run in its
 * commit window is let finish. So is a run answering a question (answering), unless a newer question came (asked): a web search
 * can take several seconds with nothing streamed, and otherwise steady talk in the room would cancel the answer again and again.
 */
export function waitsForRun(args: { fresh: boolean; runTips: number; answering: boolean; asked: boolean }): boolean {
  if (args.fresh) return false;
  return inCommitWindow(args.runTips) || (args.answering && !args.asked);
}

/** Restarts (times in ms) still inside the window. */
export function recentRestarts(
  restarts: readonly number[],
  now: number,
): number[] {
  return restarts.filter((at) => now - at < RESTART_WINDOW_MS);
}

/**
 * How long after the latest line the next run starts. The first line of a turn (steering false: no kept tips, no run in flight)
 * starts at once. While steering it is the debounce, or the pause once restarts pile up.
 */
export function runDelayMs(restarts: readonly number[], now: number, steering: boolean): number {
  if (!steering) return 0;
  return recentRestarts(restarts, now).length >= MAX_RESTARTS
    ? PAUSE_MS
    : DEBOUNCE_MS;
}

/**
 * Whether a line starts a new turn: the last answer goes from the screen (Luna still gets it as context, store.ts runPipeline).
 * A line steers the current turn (earlier tips stay, dimmed) only when it interrupts a run: it came while Bee was busy
 * (debounce, run or deferred restart), or its phrase ended while Bee was busy and its speech-to-text finished after. A fresh
 * question after an answer has settled, or any line after the island was dismissed (open false), starts afresh, however soon
 * it follows.
 */
export function isNewTurn(args: { open: boolean; busy: boolean; spokenDuringRun: boolean }): boolean {
  return !args.open || !(args.busy || args.spokenDuringRun);
}
