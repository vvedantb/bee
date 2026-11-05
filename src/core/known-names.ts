// Names Bee should know: people and chats the user cares about, spelled the way the user spells them. A local list in Settings
// that the user can edit, plus names Bee learns by itself: a spelling the user gives ("It's Z U Z A N N A") and chat names it
// reads on screen during computer use ("Chat | Zuzanna Szczepaniak-Moody | …" in Teams). Sent with each direct request so the AI
// spells them right and can match a misheard name ("Susannah") to a known one. Pure: no Electron, no fs.

/** Names kept at most. The oldest learned ones drop off first. */
export const KNOWN_NAMES_MAX = 200;
/** One name's length limit. */
export const NAME_MAX_CHARS = 80;
// Names sent to the AI at most, newest first.
const PROMPT_NAMES_MAX = 60;

const clean = (name: string) =>
  name
    .replace(/\s+/g, " ")
    .replace(/^[\s"'“‘(]+|[\s"'”’).,;:!?]+$/gu, "")
    .trim();

/** The list as stored: trimmed, no blanks or runaway lines, no repeats (any case), at most KNOWN_NAMES_MAX (the newest kept). */
export function normalizeNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = clean(raw);
    const key = name.toLowerCase();
    if (!name || name.length > NAME_MAX_CHARS || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out.slice(-KNOWN_NAMES_MAX);
}

/** The list with newly learned names added at the end. A name already there (any case) stays where it is. */
export function mergeNames(known: readonly string[], learned: readonly string[]): string[] {
  return normalizeNames([...known, ...learned]);
}

const cap = (word: string) => (word ? word[0]!.toUpperCase() + word.slice(1).toLowerCase() : word);
// A word of a person's name: a capital, then letters, apostrophes or hyphens.
const NAME_WORD = String.raw`\p{Lu}[\p{L}'’-]+`;
const PERSON = new RegExp(`^${NAME_WORD}(?: ${NAME_WORD}){0,3}$`, "u");
// Words that look like names but are Bee, the user, an app or a place on screen.
const NOT_A_NAME = /^(?:bee|you|me|chat|chats|teams|microsoft teams|search|activity|calendar|general|people|messages|files|new chat|copilot)$/i;

const isPerson = (name: string) => PERSON.test(name) && !NOT_A_NAME.test(name) && !/\(you\)/i.test(name);

// "It's Z U Z A N N A", "spelt Z-U-Z-A-N-N-A": letters one by one, right after the cue.
const SPELLED_LETTERS = /\b(?:it's|it is|its|spelt|spelled|spelling is|spell it|name is|that's|written)\s*[:,]?\s*((?:\p{L}[\s.,-]+){2,}\p{L})(?![\p{L}])/iu;
// "it's spelled Zuzanna", "spelt Zuzanna Moody".
const SPELLED_WORD = new RegExp(`\\b(?:spelt|spelled|spelling is|spelled as|spelt as|spelled like|written as)\\s+(${NAME_WORD}(?: ${NAME_WORD}){0,2})`, "u");

/** A name the user spelled out in a correction ("Bro, you spelt it wrong. It's Z U Z A N N A." → "Zuzanna"), else null. */
export function spelledName(text: string): string | null {
  const letters = SPELLED_LETTERS.exec(text);
  if (letters?.[1]) {
    const word = letters[1].replace(/[\s.,-]+/g, "");
    if (word.length >= 3 && word.length <= 30) return cap(word);
  }
  const word = SPELLED_WORD.exec(text)?.[1];
  return word && isPerson(word) ? word : null;
}

// Teams' window title: "Chat | Zuzanna Szczepaniak-Moody | Evalucom Consulting Limited | …".
const TEAMS_CHAT_TITLE = /\bChat \| ([^|"\n]+?) \|/g;
// The AI's own words: "found the chat with Zuzanna Szczepaniak-Moody", "Chat window with Sam Lee open".
const CHAT_WITH = new RegExp(`\\b(?:chat|conversation|messages?|DM) (?:window )?with (${NAME_WORD}(?:[ ]${NAME_WORD}){0,3})`, "gu");

/** People's names in text from the screen or the AI's report of it: Teams chat titles and "the chat with <Name>". */
export function screenNames(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(TEAMS_CHAT_TITLE)) found.push(clean(match[1] ?? ""));
  for (const match of text.matchAll(CHAT_WITH)) found.push(clean(match[1] ?? ""));
  return normalizeNames(found.filter(isPerson));
}

/** The names block for the AI, newest first, or "" when there are none. */
export function knownNamesBlock(names: readonly string[]): string {
  const list = normalizeNames(names).slice(-PROMPT_NAMES_MAX).reverse();
  if (list.length === 0) return "";
  return `Names the user has taught Bee (spell them this way; a misheard name, such as Susannah for Zuzanna, may be one of these): ${list.join(", ")}.`;
}
