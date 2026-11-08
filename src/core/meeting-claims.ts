import { wakeCommand } from "./wake-word";

// A last check on a meeting tip. Meeting tips have no desktop or computer tools (only notes, web search and MCP connectors), so a
// tip that says Bee opened, typed, clicked or sent something on the computer is always false: nothing ran. This swaps such a tip
// for a cautious line. Only Bee's own claims count: "Say "I sent it."" (words for the user) and "Not opened yet" pass as written.
// The direct-request path has its own check (core/claim-guard.ts) and does not use this. Pure: no Electron, no model call.

const VERBS = "opening|opened|launching|launched|typing|typed|clicking|clicked|pressing|pressed|sending|sent|submitting|submitted|closing|switching|switched";
// A tip that opens with the action ("Opening Chrome now."), or with Bee or "I" doing it ("Bee has opened Chrome.", "I'm typing hi.").
const LEADING = new RegExp(`^(?:(?:bee|i|i['’]m|i['’]ve|i have|i am)\\s+(?:is\\s+|has\\s+|have\\s+|just\\s+|now\\s+|am\\s+)*)?(?:now\\s+)?(?:${VERBS})\\b`, "i");
// "…, as requested": an action word and the phrase that a request was carried out.
const AS_REQUESTED = new RegExp(`\\b(?:${VERBS})\\b[^.!?]*\\bas (?:requested|asked)\\b`, "i");
// Doubt, denial or delay: "not opened yet", "could not send", "will open".
const NEGATED = /\b(?:not|never|no|cannot|unable|failed|without|yet|whether|if|would|will|ready to|about to|did not|was not)\b|n['’]t\b/i;
// Words for the user to say, in quotes.
const QUOTED = /["“”]/;

/** Whether a meeting tip says Bee did something on the computer. */
export function claimsComputerAction(tip: string): boolean {
  const text = tip.trim().replace(/^[-*•]\s+/, "");
  if (QUOTED.test(text) || NEGATED.test(text) || /^say\b/i.test(text)) return false;
  return LEADING.test(text) || AS_REQUESTED.test(text);
}

/** The newest transcript line without its speaker label ("me: Bee, open Chrome" → "Bee, open Chrome"). */
function newestLine(transcript: readonly string[]): string {
  const last = transcript.at(-1) ?? "";
  return last.replace(/^[^:,"]{1,40}:\s+/, "").trim();
}

export const NOT_DONE_TIP = "Bee did not do that on the computer.";
export const FOR_BEE_TIP = 'That is a request for Bee: use Talk to Bee (typed), or say "Bee" and ask it aloud.';

/**
 * The tips with every false computer-action claim swapped: for a request that starts with Bee, the line that says how to ask Bee;
 * otherwise a line that says nothing was done. Repeats of the swap line collapse to one. `transcript` is the meeting lines, newest last.
 */
export function guardMeetingTips<T extends { text: string }>(tips: readonly T[], transcript: readonly string[]): T[] {
  if (!tips.some((tip) => claimsComputerAction(tip.text))) return [...tips];
  const forBee = wakeCommand(newestLine(transcript)) !== null;
  const swap = forBee ? FOR_BEE_TIP : NOT_DONE_TIP;
  const out: T[] = [];
  for (const tip of tips) {
    if (!claimsComputerAction(tip.text)) out.push(tip);
    else if (!out.some((kept) => kept.text === swap)) out.push({ ...tip, text: swap });
  }
  return out;
}
