import { nameChoices, whichNameQuestion, type NameAmbiguity } from "./known-names";

// One question back, with no AI call, when a request to reach a person names one Bee cannot pick ("message Chris", with Chris Lee
// and Krzysztof Nowak known). Before, Bee asked "Which Chris?" and the user's answer then cost a full AI turn (about 20 s on a
// Linux test desktop) for the AI to ask which app and what to say. Now the one question asks for each missing part at once:
// which person, which app (when neither the request nor the user's recent requests or Bee's memory name one), and what to say
// (for a message with no words in it). Pure: direct-command.ts asks it before any AI call or action.

// Apps and channels people message in. One named in the request, a recent request or Bee's memory says where to send.
const MESSAGING_APP =
  /\b(?:microsoft teams|teams|slack|discord|whatsapp|signal|telegram|messenger|imessage|messages|outlook|gmail|mail|e-?mail|sms|text message|skype|google chat|zoom|element|mattermost|wechat|linkedin)\b/i;
// Polite padding in front of the request: "please", "can you".
const POLITE = /^(?:(?:please|hey|ok|okay|so|now|just|can you|could you|would you|will you)[\s,]+)+/i;
// A request that writes to the person: the message is missing when nothing but filler follows the name.
const MESSAGE_VERB = /^(?:send|message|msg|dm|ping|tell|write(?:\s+to)?|text|e-?mail|mail|reply\s+to|chat\s+(?:with|to))\b/i;
// A request that calls the person: it needs an app, not a message.
const CALL_VERB = /^(?:call|ring|phone|video\s+call|facetime)\b/i;
// The verbs above that name no channel of their own ("email" and "mail" do).
const ASKS_APP = /^(?:send|message|msg|dm|ping|tell|write|text|reply|chat|call|ring|phone|video)\b/i;
// Words around a name that are not the message: "a message", "a quick note", "on Teams", "saying".
const FILLER = new Set([
  "a", "an", "the", "quick", "short", "new", "message", "msg", "dm", "note", "text", "line", "ping", "email", "e-mail", "mail", "please", "now", "for",
  "me", "saying", "says", "say", "to", "that", "asking", "him", "her", "them", "on", "in", "via", "through", "using", "over", "app",
]);

/** What a request to reach a person leaves out: which app, and (for a message) what to say. */
export type RequestGaps = { app: boolean; body: boolean };

/**
 * The parts a request to reach the heard person leaves out. context: the user's recent requests and Bee's memory, where an app
 * named counts as named. Only messages and calls have gaps: "open chris's chat" or "find krzys" asks nothing more.
 */
export function requestGaps(command: string, heard: string, context: readonly string[] = []): RequestGaps {
  const text = command.replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "").replace(POLITE, "");
  const message = MESSAGE_VERB.test(text);
  const call = !message && CALL_VERB.test(text);
  if (!message && !call) return { app: false, body: false };
  const app = ASKS_APP.test(text) && !MESSAGING_APP.test(text) && !context.some((item) => MESSAGING_APP.test(item));
  if (call) return { app, body: false };
  // The words after the name, less the app named and the filler: anything left is the message.
  const at = text.toLowerCase().indexOf(heard.toLowerCase());
  const after = at < 0 ? "" : text.slice(at + heard.length).replace(/^['’]s\b/, "");
  const words = after
    .replace(MESSAGING_APP, " ")
    .split(/[\s,:;—–-]+/)
    .map((word) => word.toLowerCase().replace(/^["'“‘]+|["'”’]+$/gu, ""))
    .filter((word) => word.length > 0);
  return { app, body: !words.some((word) => !FILLER.has(word)) };
}

/**
 * The one question for an ambiguous person, with the other missing parts: "Which Chris (Chris Lee or Krzysztof Nowak), which
 * app, and what should the message say?". With nothing else missing, the plain "Which Chris: Chris Lee or Krzysztof Nowak?".
 */
export function clarifyingQuestion(args: { command: string; ambiguity: NameAmbiguity; context?: readonly string[] }): string {
  const gaps = requestGaps(args.command, args.ambiguity.heard, args.context);
  if (!gaps.app && !gaps.body) return whichNameQuestion(args.ambiguity);
  const parts = [`Which ${args.ambiguity.heard} (${nameChoices(args.ambiguity.matches)})`, ...(gaps.app ? ["which app"] : []), ...(gaps.body ? ["what should the message say"] : [])];
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}?`;
}
