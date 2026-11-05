import type { ModelMessage } from "ai";
import type { IrreversibleKind } from "./computer-control";

// A last check on what Bee tells the user it did. The prompts already say "never claim a send without proof", yet logs show lines
// like "Sent hi to Zuzanna." from a run that never typed or sent anything, and "No meetings today." after the calendar failed to
// open. This reads the run's own tool calls and results (and the kinds the confirm gate counted, core/computer-gate.ts) and, when
// a line claims a send, delete, purchase or form submit that nothing in THIS run proves, or claims an empty calendar with no
// successful read behind it, swaps it for a cautious line. Only a positive claim is checked: "Not sent yet" and "Could not send"
// pass as written. Pure: no Electron, no model call.

export type ClaimKind = IrreversibleKind;

// Words that say an irreversible thing happened. Past tense and whole words only, so "send", "ready to send" and "sender" never
// count. Plain "ordered" and "registered" are left out: "ordered the list", "registered the change" are not purchases.
const CLAIMS: readonly (readonly [ClaimKind, RegExp])[] = [
  ["delete", /\b(?:deleted|removed|trashed|erased|discarded|purged)\b/i],
  ["send", /\b(?:sent|re-?sent|delivered|posted|replied|messaged|e-?mailed|tweeted|published|dm['’]?d)\b/i],
  ["buy", /\b(?:purchased|bought|paid|placed (?:the |an |your |that )?order|completed (?:the )?(?:checkout|purchase))\b/i],
  ["submit", /\b(?:submitted|signed up)\b/i],
];
// A clause that denies, doubts or puts off the action: "not sent yet", "could not verify it was sent", "nothing was deleted".
const NEGATED =
  /\b(?:not|never|no|nothing|none|cannot|unable|failed|fail|without|yet|unsent|whether|if|would|will|ready to|about to|could not|did not|was not|is not|has not|have not)\b|n['’]t\b/i;
// Where a line splits into clauses, so "Sent hi, but could not close the tab" still claims the send.
const CLAUSE = /[,;.!?:]+|\s[—–-]\s|\b(?:but|and|then|so|although|though|while)\b/i;

/** Every irreversible action a line says happened, in order: "Deleted the draft and sent the email." → delete, send. */
export function claimedEffects(line: string): ClaimKind[] {
  const found: ClaimKind[] = [];
  for (const clause of line.split(CLAUSE)) {
    const text = clause.trim();
    if (!text || NEGATED.test(text)) continue;
    for (const [kind, pattern] of CLAIMS) if (pattern.test(text) && !found.includes(kind)) found.push(kind);
  }
  return found;
}

/** The first irreversible action a line says happened, or null: "Sent hi to Zuzanna." → send; "Typed hi; not sent yet." → null. */
export function claimedEffect(line: string): ClaimKind | null {
  return claimedEffects(line)[0] ?? null;
}

// Claims that a calendar is empty. Narrow on purpose: only the "no meetings" kind of answer the logs showed after a failed open.
const ABSENCE =
  /\b(?:no|zero) (?:more )?(?:meetings?|events?|appointments?|calls?)\b|\b(?:calendar|diary|schedule|day) (?:is|looks) (?:empty|clear|free)\b|\bnothing (?:is )?(?:on|in) (?:the |your )?(?:calendar|diary|schedule)\b/i;

/** The line says the calendar is empty or has no meetings. */
export function claimsEmptyCalendar(line: string): boolean {
  return ABSENCE.test(line);
}

/** What this run's tool calls and results prove. */
export type RunEvidence = {
  /** Irreversible kinds an action that succeeded was marked with (its effect) or the confirm gate counted. */
  proven: Set<ClaimKind>;
  /** Text Bee put in a field this run (set_value or type_text that succeeded), the newest last. */
  typed: string[];
  /** Tool calls made, results that succeeded, and results that were errors. */
  toolCalls: number;
  okResults: number;
  failedResults: number;
  /** Results that succeeded from a tool that reads something (a snapshot, find, read, a connector or web search): not an action. */
  okReads: number;
};

// Computer and desktop tools that act or list rather than read content: their success proves nothing about what a page says.
const NOT_READS = new Set([
  "click", "type_text", "set_value", "focus", "select_option", "set_state", "scroll", "press_key", "act", "open_app", "focus_window", "open_url", "close_app",
  "wait", "list_apps", "list_windows", "use_computer", "memory_write", "append_note",
]);
const TYPES = new Set(["set_value", "type_text"]);
const KINDS = new Set<string>(["send", "delete", "buy", "submit"]);

type Part = { type: string; [key: string]: unknown };
const parts = (message: ModelMessage): Part[] => (typeof message.content === "string" ? [{ type: "text", text: message.content }] : (message.content as unknown as Part[]));

/** A tool result as text: the text value, or the JSON of anything else. */
function resultText(output: unknown): string {
  const value = output as { type?: string; value?: unknown } | undefined;
  if (value && typeof value === "object" && (value.type === "text" || value.type === "error-text") && typeof value.value === "string") return value.value;
  if (value && typeof value === "object" && value.type === "content" && Array.isArray(value.value)) {
    return value.value.map((item: Part) => (item.type === "text" ? String(item.text ?? "") : "")).join("\n");
  }
  try {
    return JSON.stringify(value?.value ?? value ?? "");
  } catch {
    return "";
  }
}

const isDone = (text: string) => /^(?:Using [^\n]{1,120}? for [^\n]{1,120}?\. )?Done\b/.test(text.trim());
const isError = (text: string, output: unknown) => /^\s*Error\b/.test(text) || (output as { type?: string } | undefined)?.type?.startsWith("error") === true;

/** The evidence in one run's messages (the AI's tool calls and their results), plus the kinds the confirm gate counted. */
export function runEvidence(messages: readonly ModelMessage[], gateKinds: Iterable<ClaimKind> = []): RunEvidence {
  const evidence: RunEvidence = { proven: new Set(gateKinds), typed: [], toolCalls: 0, okResults: 0, failedResults: 0, okReads: 0 };
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  for (const message of messages) {
    for (const part of parts(message)) {
      if (part.type === "tool-call" && message.role === "assistant") {
        evidence.toolCalls += 1;
        const input = part.input && typeof part.input === "object" ? (part.input as Record<string, unknown>) : {};
        calls.set(String(part.toolCallId), { name: String(part.toolName), input });
      }
      if (part.type !== "tool-result" || message.role !== "tool") continue;
      const call = calls.get(String(part.toolCallId));
      const name = call?.name ?? String(part.toolName);
      const text = resultText(part.output);
      if (isError(text, part.output) || /\bBee stopped this task\b/.test(text)) {
        evidence.failedResults += 1;
        continue;
      }
      evidence.okResults += 1;
      if (!NOT_READS.has(name)) evidence.okReads += 1;
      const input = call?.input ?? {};
      if (name === "act" && Array.isArray(input.actions)) {
        // "1. click: Done." per action that ran, in order.
        for (const line of text.split("\n")) {
          const match = /^(\d+)\. \w+: (.*)$/.exec(line.trim());
          const item = match ? (input.actions[Number(match[1]) - 1] as Record<string, unknown> | undefined) : undefined;
          if (!item || !isDone(match?.[2] ?? "")) continue;
          if (KINDS.has(String(item.effect))) evidence.proven.add(item.effect as ClaimKind);
          if (TYPES.has(String(item.do))) evidence.typed.push(String(item.value ?? item.text ?? ""));
        }
        continue;
      }
      if (!isDone(text)) continue;
      if (KINDS.has(String(input.effect))) evidence.proven.add(input.effect as ClaimKind);
      if (TYPES.has(name)) evidence.typed.push(String(input.value ?? input.text ?? ""));
    }
  }
  return evidence;
}

/** Kinds Bee's own text in these messages already told the user happened (an earlier turn's "Sent hi to Sam."). */
export function claimsShown(messages: readonly ModelMessage[]): Set<ClaimKind> {
  const kinds = new Set<ClaimKind>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of parts(message)) if (part.type === "text" && typeof part.text === "string") for (const kind of claimedEffects(part.text)) kinds.add(kind);
  }
  return kinds;
}

/**
 * Evidence for an answer that may talk about earlier turns ("Yes, Bee sent it at 3 pm."): this turn's tool calls and results,
 * plus what earlier turns proved or already told the user. Earlier claims count because the history keeps the line the user
 * saw, never an unproven claim Bee replaced (replaceLastText).
 */
export function answerEvidence(turn: readonly ModelMessage[], history: readonly ModelMessage[]): RunEvidence {
  const evidence = runEvidence(turn);
  for (const kind of runEvidence(history).proven) evidence.proven.add(kind);
  for (const kind of claimsShown(history)) evidence.proven.add(kind);
  return evidence;
}

/**
 * The messages with the AI's last text replaced by the line the user was shown, its tool calls kept, so the history never holds a
 * claim Bee did not stand behind. With no assistant text, the line is added at the end.
 */
export function replaceLastText(messages: readonly ModelMessage[], line: string): ModelMessage[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const content = parts(message);
    if (!content.some((part) => part.type === "text")) continue;
    const kept = content.filter((part) => part.type !== "text");
    const next = { ...message, content: [...kept, { type: "text", text: line }] } as ModelMessage;
    return [...messages.slice(0, index), next, ...messages.slice(index + 1)];
  }
  return [...messages, { role: "assistant", content: [{ type: "text", text: line }] }];
}

const TYPED_SHOWN_MAX = 30;

/** The cautious line for a claim nothing proves. */
export function unprovenLine(kind: ClaimKind, typed: readonly string[] = []): string {
  const last = (typed.at(-1) ?? "").replace(/\s+/g, " ").trim();
  switch (kind) {
    case "send":
      if (!last) return "Bee could not confirm anything was sent.";
      return last.length <= TYPED_SHOWN_MAX ? `Typed "${last}"; Bee could not confirm it was sent.` : "Typed the message; Bee could not confirm it was sent.";
    case "delete":
      return "Bee could not confirm anything was deleted.";
    case "buy":
      return "Bee could not confirm the purchase went through.";
    case "submit":
      return "Bee could not confirm the form was submitted.";
  }
}

/** The line for an empty-calendar claim with no successful read behind it. */
export const UNSEEN_CALENDAR_LINE = "Bee could not read the calendar, so it cannot say whether you have meetings.";

export type GuardedLine = { line: string; rewritten: boolean; reason: ClaimKind | "unseen-calendar" | null };

/**
 * The line to show. A claimed send, delete, purchase or submit stays only when the run proves that kind; an empty-calendar claim
 * stays only when a read in the run succeeded. requireProof false (an answer with no computer tools): a claim stays when any
 * tool result succeeded, since a connector may have done it; with no successful result at all it is rewritten.
 */
export function guardLine(line: string, evidence: RunEvidence, options: { requireProof?: boolean } = {}): GuardedLine {
  const requireProof = options.requireProof ?? true;
  for (const claim of claimedEffects(line)) {
    const proven = requireProof ? evidence.proven.has(claim) : evidence.proven.has(claim) || evidence.okResults > 0;
    if (!proven) return { line: unprovenLine(claim, evidence.typed), rewritten: true, reason: claim };
  }
  if (claimsEmptyCalendar(line) && evidence.toolCalls > 0 && evidence.okReads === 0) return { line: UNSEEN_CALENDAR_LINE, rewritten: true, reason: "unseen-calendar" };
  return { line, rewritten: false, reason: null };
}
