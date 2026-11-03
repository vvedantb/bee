import { isFiller } from "./steering";

// "Bee" wake word: a mic phrase that starts by naming Bee is a request to the AI, not meeting conversation. Pure: no window,
// React or Electron here, so tests can call it.

/** Where a line came from. Only "mic" (the user's own mic) can wake Bee. */
export type LineSource = "mic" | "typed" | "caption" | "teams-audio" | "teammate";

// Leading quotes or brackets STT sometimes adds.
const LEAD = String.raw`^[\s"'“‘(\[]*`;
// "Hey" before the name: "Hey Bee", "Hey, Bee", "Hey. Bee".
const HEY = String.raw`(?:hey[\s,.!]+)?`;
// The name, and how STT mishears it. Longest first, so "bee" is not read as "be" + "e".
const NAME = "(bee|bea|be|b)";
// The name is a whole word: a space, punctuation or the end follows it ("Bees", "Been", "B2B", "Bee's", "B-tree" do not wake).
const BOUNDARY = String.raw`(?=[\s,.!?:;…—–]|$)`;
// Punctuation after the name, then the request.
const WAKE = new RegExp(`${LEAD}${HEY}${NAME}${BOUNDARY}([\\s,.!?:;…—–]*)(.*)$`, "isu");

// "B", "Be" and "Bea" are also ordinary words and names ("Be careful", "Be there at five"). Without a pause after them (a comma,
// colon, dash or "!"), they wake Bee only when the request opens like one: an action or a question.
const PAUSE = /[,:!…—–]/;
const REQUEST_START =
  /^(?:open|launch|start|focus|switch|show|bring|go|pull|find|search|look|check|calculate|convert|translate|define|explain|summari[sz]e|remind|what|what's|whats|how|how's|who|who's|when|where|why|which|please|tell me|give me|can you|could you|stop|cancel)\b/i;

/**
 * The request after the wake word, or null when the line does not start with it. "Bee open Teams" → "open Teams";
 * "Hey Bee, what's 15% of 18000?" → "what's 15% of 18000?". The name alone ("Bee.") is "": a wake word with no request.
 * "B", "Be" and "Bea" alone are null: too likely to be other speech.
 */
export function wakeCommand(line: string): string | null {
  const match = WAKE.exec(line.trim());
  if (!match) return null;
  const name = (match[1] ?? "").toLowerCase();
  const pause = match[2] ?? "";
  const request = (match[3] ?? "").trim();
  if (name === "bee") return request;
  if (request === "") return null;
  return PAUSE.test(pause) || REQUEST_START.test(request) ? request : null;
}

/** After "Bee" alone, the next mic phrase within this long is the request: a pause after the name ends the phrase. */
export const WAKE_FOLLOW_MS = 8000;

// "Bee, stop": the whole request asks Bee to stop what it is doing.
const STOP = /^(?:(?:please|ok|okay|no|now|just)[\s,]+)*(?:stop|stop it|stop that|stop now|stop please|cancel|cancel it|cancel that|abort|halt|never ?mind|forget it)[\s.!,]*(?:please|now|thanks|thank you)?[\s.!]*$/i;

/** The request is "stop", "cancel", "never mind": Bee stops the task in progress. */
export function isStopCommand(command: string): boolean {
  return STOP.test(command.replace(/\s+/g, " ").trim());
}

// "Bee, yes, send it": an answer to a Confirm prompt. Only a tap answers one, so the store ignores this rather than taking it
// as a new request that would cancel the task.
const CONFIRM_WORDS = /^(?:(?:yes|yeah|yep|ok|okay|sure|confirm(?:ed)?|go ahead|do it|send it|delete it|submit it|buy it)[\s,.!]*)+(?:please|thanks)?[\s.!]*$/i;

/** The request only says yes to a prompt ("confirm", "yes, send it"). */
export function isConfirmWords(command: string): boolean {
  return CONFIRM_WORDS.test(command.replace(/\s+/g, " ").trim());
}

/**
 * After a request is answered, the conversation window stays open this long: a mic phrase without "Bee" that looks addressed to
 * Bee is a follow-up. Each exchange restarts it. Separate from WAKE_FOLLOW_MS, which is only for the phrase after "Bee" alone.
 */
export const CONVERSATION_WINDOW_MS = 20_000;
/** An unclear phrase in the window (routeLine "unclear") may get one small AI call (core/follow-up.ts). Its answer. */
export type FollowUpVerdict = { addressed: "bee" | "meeting"; confidence: number };
/** Bee acts on that answer only at or above this confidence. */
export const FOLLOW_UP_CONFIDENCE = 0.7;
/** No one else heard for this long: the call's prompt leans toward Bee. */
export const OTHERS_QUIET_MS = 60_000;

/** Bee takes the phrase as a follow-up: the verdict says bee, at FOLLOW_UP_CONFIDENCE or more. */
export function isForBee(verdict: FollowUpVerdict | null): boolean {
  return verdict?.addressed === "bee" && verdict.confidence >= FOLLOW_UP_CONFIDENCE;
}

/** While Bee's last reply asks a question ("Which team?"), the window stays open up to this long for the answer. */
export const CONVERSATION_QUESTION_MS = 60_000;

// "Thanks", "that's all", "never mind": the user is done with Bee. Only the whole phrase counts.
const CLOSE = /^(?:(?:ok|okay|yeah|yes|yep|great|perfect|cool|nice|right|good|lovely|brilliant)[\s,.!]+)*(?:thanks|thank you|thanks bee|thank you bee|cheers|ta|that's all|that is all|that's it|that is it|that'll do|all good|we're good|done|i'm done|got it|bye|bye bee)(?:[\s,.!]+(?:thanks|thank you|bee|for now|then))*[\s.!]*$/i;

/** The phrase ends the conversation with Bee: "thanks", "that's all", "OK, got it". */
export function isConversationClose(text: string): boolean {
  return CLOSE.test(text.replace(/\s+/g, " ").trim());
}

// Talking to Bee: "you", "why did you…", "can you…".
const SECOND_PERSON = /\b(?:you|your|you're|youre|you've|you'd|yourself)\b/i;
// Correcting Bee: "no, the team one", "that's wrong", "not that", "actually…", "instead".
const CORRECTION = /^(?:no|nope|nah|not that|not quite|wrong|that's wrong|that is wrong|that's not|that isn't|actually|instead|try again|again)\b|\binstead\b/i;
// Pointing at what Bee just did or showed: "that page", "the team one", "it", "go back".
const STRONG_REFERENCE = /\b(?:that|this|the)\s+(?:page|one|tab|link|app|window|site|url|screen|file|message)\b|\bthe\s+\w+(?:\s+\w+)?\s+one\b/i;
const REFERENCE = /\b(?:it|there|back)\b/i;
// An instruction or a question to Bee: the wake word's request verbs, and a few more for follow-ups.
const FOLLOW_VERB = /^(?:(?:so|and|ok|okay|then|now|just|please)[\s,]+)*(?:open|launch|start|focus|switch|show|bring|go|pull|find|search|look|check|click|scroll|close|try|use|read|calculate|convert|translate|define|explain|summari[sz]e|remind|what|what's|whats|how|how's|who|who's|when|where|why|which|tell me|give me|can you|could you|do it|did it|is it|stop|cancel)\b/i;
// A short answer to Bee's question ("Which team?" → "the Acme one", "Acme").
const SHORT_ANSWER_WORDS = 5;

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

/**
 * Why the phrase looks addressed to Bee in the conversation window, or null: second person, a correction, a pointer at what
 * Bee just did, an instruction or question, or a short answer when Bee's last reply asked a question. Heuristic only.
 */
export function looksAddressedToBee(text: string, lastBee?: { request: string; reply: string } | null): string | null {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return null;
  // A bare "no" is an answer only to Bee's question; otherwise it is likely for someone in the meeting.
  if (/^(?:no|nope|nah)[.!]*$/i.test(line)) return lastBee?.reply.includes("?") ? "answer" : null;
  if (SECOND_PERSON.test(line)) return "second-person";
  if (CORRECTION.test(line)) return "correction";
  if (FOLLOW_VERB.test(line)) return "instruction";
  if (STRONG_REFERENCE.test(line)) return "reference";
  // "Yeah", "it is", "okay then": filler is never for Bee on its own.
  if (isFiller(line)) return null;
  if (REFERENCE.test(line) && words(line) <= 12) return "reference";
  if (lastBee && lastBee.reply.includes("?") && words(line) <= SHORT_ANSWER_WORDS) return "answer";
  return null;
}

/** The phrase names someone in the meeting ("Priya, what do you think?"): it is for them, not Bee. Whole words, any case. */
export function namesParticipant(text: string, participants: readonly string[] = []): string | null {
  const line = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}'\s-]+/gu, " ")} `;
  for (const name of participants) {
    const first = name.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    // "Me", "Meeting", one-letter names and Bee's own name never count.
    if (first.length < 2 || ["me", "meeting", "bee", "you"].includes(first)) continue;
    if (line.includes(` ${first} `)) return name;
  }
  return null;
}

/**
 * What to do with a new line: a direct request to the AI ("Bee, open Teams", or a follow-up in the conversation window),
 * "Bee, stop" (end the task in progress), "Bee" alone (the request is the next mic phrase, see WAKE_FOLLOW_MS), "thanks" (close
 * the conversation window), a phrase in the window that may or may not be for Bee (unclear: the store may ask the AI once), or a
 * meeting line. reason says why, for the local debug log.
 */
export type LineRoute =
  | { kind: "command"; command: string; followUp?: boolean; reason?: string }
  | { kind: "stop" }
  | { kind: "wake" }
  | { kind: "close" }
  | { kind: "unclear" }
  | { kind: "meeting"; reason?: string };

/**
 * Only the user's own mic phrases can wake Bee, and only with the setting on. Typed lines, captions, Teams audio and teammates'
 * synced lines always go to the meeting, even when they start with "Bee", "Bee, stop" included: nobody else can start or stop
 * what Bee does on the computer. armed: the last mic phrase was "Bee" alone, so this one is the request. conversationOpen: a
 * request was answered moments ago (CONVERSATION_WINDOW_MS), so a phrase without "Bee" can still be for Bee. othersSpoke: someone
 * else spoke since that answer, so a phrase that is not clearly for Bee is a reply to them.
 */
export function routeLine(args: {
  text: string;
  source: LineSource;
  enabled: boolean;
  armed?: boolean;
  conversationOpen?: boolean;
  lastBee?: { request: string; reply: string } | null;
  participants?: readonly string[];
  othersSpoke?: boolean;
}): LineRoute {
  if (!args.enabled || args.source !== "mic") return { kind: "meeting" };
  const command = wakeCommand(args.text);
  if (command === "") return { kind: "wake" };
  const text = args.text.trim();
  const request = command ?? (args.armed && !isFiller(text) ? text : null);
  if (request !== null) return isStopCommand(request) ? { kind: "stop" } : { kind: "command", command: request };
  if (!args.conversationOpen) return { kind: "meeting" };
  if (isStopCommand(text)) return { kind: "stop" };
  if (isConversationClose(text)) return { kind: "close" };
  if (namesParticipant(text, args.participants)) return { kind: "meeting", reason: "names-participant" };
  const addressed = looksAddressedToBee(text, args.lastBee);
  if (!addressed && isFiller(text)) return { kind: "meeting", reason: "filler" };
  // After someone else spoke, "you" or a question may be for them: only a correction or a pointer at Bee's page still counts.
  const strong = addressed === "correction" || (addressed === "reference" && STRONG_REFERENCE.test(text));
  if (addressed && (!args.othersSpoke || strong)) return { kind: "command", command: text, followUp: true, reason: addressed };
  // Someone else spoke since Bee answered: an unclear phrase is a reply to them.
  if (args.othersSpoke) return { kind: "meeting", reason: "reply-to-others" };
  return { kind: "unclear" };
}
