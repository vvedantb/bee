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
  /^(?:open|launch|start|focus|switch|show|bring|go|pull|find|search|look|check|calculate|convert|translate|define|explain|summari[sz]e|remind|what|what's|whats|how|how's|who|who's|when|where|why|which|please|tell me|give me|can you|could you)\b/i;

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

/**
 * What to do with a new line: a direct request to the AI, "Bee" alone (the request is the next mic phrase, see WAKE_FOLLOW_MS),
 * or a meeting line.
 */
export type LineRoute = { kind: "command"; command: string } | { kind: "wake" } | { kind: "meeting" };

/**
 * Only the user's own mic phrases can wake Bee, and only with the setting on. Typed lines, captions, Teams audio and teammates'
 * synced lines always go to the meeting, even when they start with "Bee". armed: the last mic phrase was "Bee" alone, so this
 * one is the request.
 */
export function routeLine(args: { text: string; source: LineSource; enabled: boolean; armed?: boolean }): LineRoute {
  if (!args.enabled || args.source !== "mic") return { kind: "meeting" };
  const command = wakeCommand(args.text);
  if (command === "") return { kind: "wake" };
  if (command !== null) return { kind: "command", command };
  const text = args.text.trim();
  return args.armed && !isFiller(text) ? { kind: "command", command: text } : { kind: "meeting" };
}
