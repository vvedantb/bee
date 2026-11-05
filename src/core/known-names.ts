// Names Bee should know: people and chats the user cares about, spelled the way the user spells them. A local list in Settings
// that the user can edit, plus names Bee learns by itself: a spelling the user gives ("It's Z U Z A N N A") and chat names it
// reads on screen during computer use ("Chat | Zuzanna Szczepaniak-Moody | …" in Teams), and a correction the user says ("I meant
// Krzysztof"). Sent with each direct request so the AI spells them right and can match a misheard name ("Susannah") to a known
// one. When a heard name sounds like more than one known person (Chris: Chris Lee or Krzysztof Nowak), Bee asks which one: no
// name is ever mapped to another for good, as two people can share a sound. Pure: no Electron, no fs.

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

// "I meant Krzysztof", "not Chris, Krzysztof", "Krzysztof, not Chris", "it's Krzysztof not Chris", "no, I said Krzysztof".
const NAME_GROUP = `(${NAME_WORD}(?: ${NAME_WORD}){0,2})`;
// The name corrected away from is capitalised too, so "Chris, not that one" is no correction.
const CORRECTIONS = [
  new RegExp(`\\b(?:i|I) (?:meant|mean|said)\\s+${NAME_GROUP}`, "u"),
  new RegExp(`\\bnot \\p{Lu}\\p{L}+[,;]?\\s+(?:but\\s+|it's\\s+|its\\s+)?${NAME_GROUP}`, "u"),
  new RegExp(`(?:^|[,.;]\\s*|\\b(?:it's|its|it is)\\s+)${NAME_GROUP},?\\s+not\\s+\\p{Lu}\\p{L}+`, "u"),
];

/**
 * The name the user corrects Bee to ("No, I meant Krzysztof." → "Krzysztof"; "Krzysztof Nowak, not Chris" → "Krzysztof Nowak"),
 * else null. Only a person-like name in a correction counts: Bee learns the spelling, never a rule that one name means another.
 */
export function correctedName(text: string): string | null {
  const line = text.replace(/\s+/g, " ").trim();
  for (const pattern of CORRECTIONS) {
    const name = clean(pattern.exec(line)?.[1] ?? "");
    if (name && isPerson(name)) return name;
  }
  return null;
}

// Words that start a sentence or a request and are never the name the user said.
const NOT_HEARD = /^(?:bee|send|message|text|email|call|tell|ask|open|show|find|please|hey|hi|hello|the|and|then|to|in|on|with|for|from|that|this|it|what|who|when|where|why|how|yes|no|ok|okay|my|me|him|her|them|team|teams|slack|chat|chrome)$/i;

/**
 * A rough sound key for one word of a name, for matching a misheard name across spellings: accents off; chr→kr, rz→r (Polish
 * Krzys sounds near Chris), sz→s, cz→c, ph→f, ck→k, soft c→s, other c, q→k, x→ks, w→v, z→s, y→i; h after the first letter goes,
 * doubles go, then vowels after the first letter. "Zuzanna" and "Susannah" share one (ssn); so do "Chris" and "Krzys" (krs); "Sean"
 * (sn) does not. General rules, no person's name in them.
 */
export function soundKey(word: string): string {
  let text = word
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/ł/g, "l")
    .replace(/ß/g, "ss")
    .replace(/[^a-z]/g, "");
  text = text
    .replace(/^chr/, "kr")
    .replace(/rz/g, "r")
    .replace(/sz/g, "s")
    .replace(/cz/g, "c")
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c|q/g, "k")
    .replace(/x/g, "ks")
    .replace(/w/g, "v")
    .replace(/z/g, "s")
    .replace(/y/g, "i");
  const first = text.slice(0, 1);
  const rest = text
    .slice(1)
    .replace(/h/g, "")
    .replace(/(.)\1+/g, "$1")
    .replace(/[aeiou]/g, "");
  return `${first}${rest}`;
}

/** Two sound keys match: the same, or one starts the other and is 3 or more long (Chris is the start of Krzysztof, Christopher). */
const soundsLike = (a: string, b: string) => a.length >= 2 && b.length >= 2 && (a === b || (Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a))));

/** Known names whose first word sounds like the heard word: "Chris" → Chris Lee, Krzysztof Nowak. */
export function namesSoundingLike(heard: string, known: readonly string[]): string[] {
  const key = soundKey(heard);
  if (key.length < 2) return [];
  return normalizeNames(known).filter((name) => {
    const first = name.split(" ")[0] ?? "";
    return first.toLowerCase() === heard.toLowerCase() || soundsLike(key, soundKey(first));
  });
}

export type NameAmbiguity = { heard: string; matches: string[] };

/**
 * Names in a request that could be more than one known person: a capitalised word (STT capitalises names) whose sound matches two
 * or more known names, unless the request also names something that tells them apart (a surname). "send Chris hi" with Chris Lee
 * and Krzysztof Nowak known → Chris: both. "send Chris Lee hi" → none.
 */
export function nameAmbiguities(request: string, known: readonly string[]): NameAmbiguity[] {
  const words = request.match(/\p{Lu}[\p{L}'’-]+/gu) ?? [];
  const lower = request.toLowerCase();
  const found: NameAmbiguity[] = [];
  for (const heard of new Set(words)) {
    if (heard.length < 3 || NOT_HEARD.test(heard)) continue;
    const matches = namesSoundingLike(heard, known);
    if (matches.length < 2) continue;
    // A full known name in the request ("Chris Lee") settles it.
    if (matches.some((name) => name.includes(" ") && lower.includes(name.toLowerCase()))) continue;
    if (!found.some((item) => item.heard === heard)) found.push({ heard, matches: matches.slice(0, 4) });
  }
  return found;
}

/** The question Bee asks for the first ambiguous name: "Which Chris: Chris Lee or Krzysztof Nowak?" */
export function whichNameQuestion(ambiguity: NameAmbiguity): string {
  const options = ambiguity.matches;
  const list = options.length <= 2 ? options.join(" or ") : `${options.slice(0, -1).join(", ")} or ${options.at(-1)}`;
  return `Which ${ambiguity.heard}: ${list}?`;
}

/**
 * The names block for the AI, newest first, or "" when there are none. With the request, a line for each name in it that could
 * be more than one known person, so the AI asks rather than picks.
 */
export function knownNamesBlock(names: readonly string[], request?: string): string {
  const list = normalizeNames(names).slice(-PROMPT_NAMES_MAX).reverse();
  if (list.length === 0) return "";
  const block = `Names the user has taught Bee (spell them this way; a misheard name, such as Susannah for Zuzanna, may be one of these; when it could be more than one of them, ask which): ${list.join(", ")}.`;
  const unclear = request ? nameAmbiguities(request, list) : [];
  if (unclear.length === 0) return block;
  return [
    block,
    ...unclear.map(({ heard, matches }) => `"${heard}" in this request could be ${matches.join(" or ")}. Ask the user which one before acting on that name; never pick one yourself.`),
  ].join("\n");
}
