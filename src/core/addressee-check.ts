import { debugLog, msSince } from "./debug-log";
import { isFiller } from "./steering";
import { ADDRESSEE_THRESHOLD_DEFAULT, clampAddresseeThreshold } from "./addressee-settings";
import {
  looksAddressedToBee,
  looksLikeRequest,
  namesParticipant,
  replyInvitesAnswer,
  type FollowUpVerdict,
} from "./wake-word";

// The addressee check: in a call, was an own mic phrase without "Bee" said to Bee or to the people on the call? It only adds to
// the unclear path of core/wake-word.ts routeLine. "Bee" always wakes, and the conversation window's heuristics still decide
// the clear cases first. Two steps: a free local prefilter, then (rarely) one short Haiku call. Pure apart from
// the debug log and the injected model call, so tests can call it. The call itself is in core/addressee-model.ts (main only),
// so the renderer does not load the AI SDK.

/** A longer phrase with nothing aimed at an assistant is a statement to the meeting. */
export const ADDRESSEE_MAX_WORDS = 25;

/** What the check knows about the phrase. Lines are labelled "me:" or "them:", oldest first. */
export type AddresseeInput = {
  phrase: string;
  lastBee: { request: string; reply: string } | null;
  lines: readonly string[];
  participants?: readonly string[];
  conversationOpen?: boolean;
  /** No one else heard for OTHERS_QUIET_MS. This only leans the prompt. */
  othersQuiet: boolean;
  /**
   * Someone else spoke after Bee's last exchange (lastOtherSpeakerAt > lastExchangeAt). Not the same as othersQuiet, and not
   * the last session line: session lines never hold Bee's own command or answer. Omitted reads as false.
   */
  othersSpoke?: boolean;
};

export type Prefilter = { runModel: boolean; reason: string };

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

/**
 * Free, synchronous: does the phrase need the model? Skips what is clearly not for Bee: no recent Bee exchange or no open
 * window, a participant's name, filler, a long statement, or (after someone else spoke) weak "you" talk with no request.
 * Passes on "you", an instruction or question, a correction, a pointer at Bee's page or connector, and a short answer or
 * borderline phrase with a recent Bee exchange. Reuses the wake-word helpers; adds no new matching of its own.
 */
export function prefilterAddressee(input: AddresseeInput): Prefilter {
  const phrase = input.phrase.replace(/\s+/g, " ").trim();
  if (!input.lastBee) return { runModel: false, reason: "no-exchange" };
  if (input.conversationOpen === false) return { runModel: false, reason: "conversation-closed" };
  if (namesParticipant(phrase, input.participants)) return { runModel: false, reason: "names-participant" };
  const addressed = looksAddressedToBee(phrase, input.lastBee);
  if (!addressed && isFiller(phrase)) return { runModel: false, reason: "filler" };
  const assistantStyle = addressed !== null || looksLikeRequest(phrase);
  if (!assistantStyle && wordCount(phrase) > ADDRESSEE_MAX_WORDS) return { runModel: false, reason: "long-statement" };
  // Someone else just spoke: "you" or a bare question is as likely meant for them. Only a strong pointer at Bee counts.
  const strong = addressed === "correction" || addressed === "connector" || addressed === "reference";
  if (input.othersSpoke === true && !strong && addressed !== "answer") return { runModel: false, reason: "reply-to-others" };
  if (addressed) return { runModel: true, reason: addressed };
  if (assistantStyle) return { runModel: true, reason: "request-style" };
  // Unclear, but Bee just spoke: let the model decide.
  return { runModel: true, reason: replyInvitesAnswer(input.lastBee.reply) ? "borderline-answer" : "borderline" };
}

export type AddresseeDecision = {
  decision: "bee" | "meeting" | "skipped";
  /** Why: the prefilter's reason, "disabled", "model-failed", "model-meeting" (the model said meeting), "below-threshold" (bee under the threshold), or "model". */
  reason: string;
  prefilter: Prefilter | null;
  /** The model's confidence that the phrase is for Bee, null when it did not run or failed. */
  score: number | null;
  threshold: number;
  latencyMs: number;
};

/** A short snippet for the log. The local debug log redacts the text; the full phrase is never logged here. */
function snippet(phrase: string): string {
  const line = phrase.replace(/\s+/g, " ").trim();
  return line.length > 40 ? `${line.slice(0, 39)}…` : line;
}

/**
 * Prefilter, then the model, then the threshold. Fails closed: disabled, skipped, a failed call or a score below the
 * threshold are all "meeting" (Bee stays quiet). "bee" only when the model says bee at the threshold or more. Logs every
 * decision. classify is the model call (askAddresseeModel in main, or the IPC call from the renderer); tests pass a mock.
 */
export async function decideAddressee(args: {
  input: AddresseeInput;
  enabled: boolean;
  threshold?: number;
  classify: (input: AddresseeInput) => Promise<FollowUpVerdict | null>;
}): Promise<AddresseeDecision> {
  const started = performance.now();
  const threshold = clampAddresseeThreshold(args.threshold ?? ADDRESSEE_THRESHOLD_DEFAULT);
  const finish = (partial: Omit<AddresseeDecision, "threshold" | "latencyMs">): AddresseeDecision => {
    const result = { ...partial, threshold, latencyMs: Math.round(msSince(started)) };
    debugLog.info("addressee", "decision", {
      snippet: snippet(args.input.phrase),
      prefilter: result.prefilter,
      score: result.score,
      threshold,
      decision: result.decision,
      reason: result.reason,
      latencyMs: result.latencyMs,
    });
    return result;
  };
  if (!args.enabled) return finish({ decision: "meeting", reason: "disabled", prefilter: null, score: null });
  const prefilter = prefilterAddressee(args.input);
  if (!prefilter.runModel) return finish({ decision: "skipped", reason: prefilter.reason, prefilter, score: null });
  const verdict = await args.classify(args.input).catch(() => null);
  if (!verdict) return finish({ decision: "meeting", reason: "model-failed", prefilter, score: null });
  // The score is the confidence that the phrase is for Bee: a "meeting" verdict at 0.9 is 0.1 for Bee.
  const score = verdict.addressed === "bee" ? verdict.confidence : 1 - verdict.confidence;
  const forBee = verdict.addressed === "bee" && verdict.confidence >= threshold;
  return finish({ decision: forBee ? "bee" : "meeting", reason: forBee ? "model" : verdict.addressed === "meeting" ? "model-meeting" : "below-threshold", prefilter, score: Math.round(score * 100) / 100 });
}
