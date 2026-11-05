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
export const CONVERSATION_WINDOW_MS = 60_000;
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
export const CONVERSATION_QUESTION_MS = 120_000;

// "Thanks", "that's all", "never mind": the user is done with Bee. Only the whole phrase counts.
const CLOSE = /^(?:(?:ok|okay|yeah|yes|yep|no|nope|nah|great|perfect|cool|nice|right|good|lovely|brilliant)[\s,.!]+)*(?:thanks|thank you|thanks bee|thank you bee|cheers|ta|that's all|that is all|that's it|that is it|that'll do|all good|we're good|done|i'm done|got it|bye|bye bee)(?:[\s,.!]+(?:thanks|thank you|bee|for now|then))*[\s.!]*$/i;

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
// Pointing Bee at one of its own tools: "use the vmem connector", "search vmem", "try it with the Eva connector", "check MCP".
// "vmem" is only ever Bee's connector; Eva or any other name counts only with "connector", as it may be a person.
const CONNECTOR = /\bvmem\b|\b(?:use|using|search|try|check|query|ask|with|via|in|from|through)\s+(?:the\s+|my\s+|your\s+|bee['’]?s\s+)?(?:mcp|connectors?|[\p{L}\p{N}-]+\s+connectors?)\b/iu;
// A short answer to Bee's question ("Which team?" → "the Acme one", "Acme").
const SHORT_ANSWER_WORDS = 5;
// Bee offering to do more: "say if you want those counted too", "Bee can also count staging", "want Bee to…?".
const OFFER =
  /\b(?:say (?:if|so|the word)|if you(?:'d|['’]d| would)? (?:want|like|need|prefer)|want (?:me|bee) to|shall (?:i|bee)|should (?:i|bee)|would you like|do you want|(?:bee|i) can also|(?:bee|i) could also|let (?:me|bee) know)\b/i;
// Yes or no to Bee's question or offer: "Yes.", "Yes, I do.", "Yes, can we do that?", "ok, go ahead", "nope". Never "okay" or
// "please" alone at the start ("Okay, let's move on" is for the meeting).
const YES_NO =
  /^(?:(?:ok|okay)[\s,]+)?(?:yes|yeah|yep|yup|yes please|sure|go ahead|do it|please do|correct|absolutely|definitely|of course|no|nope|nah)\b/i;
const YES_NO_WORDS = 8;

/** Bee's reply asks a question or offers to do more: a short yes or no is an answer to it. */
export function replyInvitesAnswer(reply: string | null | undefined): boolean {
  return !!reply && (reply.includes("?") || OFFER.test(reply));
}

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

/**
 * Why the phrase looks addressed to Bee in the conversation window, or null: one of Bee's connectors, second person, a
 * correction, a pointer at what Bee just did, an instruction or question, or a short answer when Bee's last reply asked a
 * question or offered to do more (replyInvitesAnswer). Heuristic only.
 */
export function looksAddressedToBee(text: string, lastBee?: { request: string; reply: string } | null): string | null {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return null;
  const invites = replyInvitesAnswer(lastBee?.reply);
  // A bare "no" is an answer only to Bee's question or offer; otherwise it is likely for someone in the meeting.
  if (/^(?:no|nope|nah)[.!]*$/i.test(line)) return invites ? "answer" : null;
  if (CONNECTOR.test(line)) return "connector";
  if (SECOND_PERSON.test(line)) return "second-person";
  if (CORRECTION.test(line)) return "correction";
  if (FOLLOW_VERB.test(line)) return "instruction";
  if (STRONG_REFERENCE.test(line)) return "reference";
  // "Yes, I do", "ok do it": yes or no to Bee's question or offer. Without one, it is likely for someone in the meeting.
  if (invites && YES_NO.test(line) && words(line) <= YES_NO_WORDS) return "answer";
  // "Yeah", "it is", "okay then": filler is never for Bee on its own.
  if (isFiller(line)) return null;
  if (REFERENCE.test(line) && words(line) <= 12) return "reference";
  if (invites && words(line) <= SHORT_ANSWER_WORDS) return "answer";
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

/** Just after the conversation closed ("thanks", silence), a clear desktop request without "Bee" reopens it for this long. */
export const REOPEN_WINDOW_MS = 45_000;

// "Open Teams", "I said open teams", "Can you open the Teams app please": a desktop verb at the very start, after polite or
// repeat words. Not "open question…", "start with…", "open to ideas": those are meeting talk.
const REOPEN =
  /^(?:(?:i said|i asked you to|just|please|bee|ok|okay|so|now|and|then|can you|could you|would you|will you)[\s,.!]+)*(?:open|launch|start|close|quit|switch to|bring up|show me|focus on|focus)\s+(?!(?:with|by|question|questions|issue|issues|item|items|to|on|off|up|for|about|it up|the floor|the meeting|the call|the discussion)\b)[\p{L}\p{N}]/iu;
const REOPEN_WORDS = 12;

/** The phrase is a clear desktop request on its own ("open Teams", "I said open teams"), short enough to be for Bee. */
export function isReopenCommand(text: string): boolean {
  const line = text.replace(/\s+/g, " ").trim();
  return words(line) <= REOPEN_WORDS && REOPEN.test(line);
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
 * else spoke since that answer, so a phrase that is not clearly for Bee is a reply to them. recentlyClosed: the window closed
 * moments ago (REOPEN_WINDOW_MS), so a clear desktop request ("open Teams") reopens it; used only while the window is shut.
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
  recentlyClosed?: boolean;
}): LineRoute {
  if (!args.enabled || args.source !== "mic") return { kind: "meeting" };
  const command = wakeCommand(args.text);
  if (command === "") return { kind: "wake" };
  const text = args.text.trim();
  const request = command ?? (args.armed && !isFiller(text) ? text : null);
  if (request !== null) return isStopCommand(request) ? { kind: "stop" } : { kind: "command", command: request };
  if (!args.conversationOpen) {
    const reopen = args.recentlyClosed && !args.othersSpoke && isReopenCommand(text) && !namesParticipant(text, args.participants);
    return reopen ? { kind: "command", command: text, followUp: true, reason: "reopen" } : { kind: "meeting" };
  }
  if (isStopCommand(text)) return { kind: "stop" };
  if (isConversationClose(text)) return { kind: "close" };
  if (namesParticipant(text, args.participants)) return { kind: "meeting", reason: "names-participant" };
  const addressed = looksAddressedToBee(text, args.lastBee);
  if (!addressed && isFiller(text)) return { kind: "meeting", reason: "filler" };
  // After someone else spoke, "you" or a question may be for them: only a correction, a pointer at Bee's page or one of Bee's
  // connectors still counts.
  const strong = addressed === "correction" || addressed === "connector" || (addressed === "reference" && STRONG_REFERENCE.test(text));
  if (addressed && (!args.othersSpoke || strong)) return { kind: "command", command: text, followUp: true, reason: addressed };
  // Someone else spoke since Bee answered: an unclear phrase is a reply to them.
  if (args.othersSpoke) return { kind: "meeting", reason: "reply-to-others" };
  return { kind: "unclear" };
}
