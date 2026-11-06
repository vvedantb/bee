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

// Words that start a sentence or a request and are never the name the user said, and app and place words ("open chrome").
const NOT_HEARD =
  /^(?:bee|send|message|messages|text|email|mail|call|tell|ask|open|show|find|search|please|hey|hi|hello|the|and|then|to|in|on|with|for|from|that|this|it|what|who|when|where|why|how|yes|no|ok|okay|my|me|him|her|them|team|teams|slack|chat|chats|chrome|outlook|calendar|discord|whatsapp|signal|zoom|gmail|notes|word|excel|google|browser|app|inbox|thread|channel|group|everyone|someone|all)$/i;

// The letters a name is compared by: accents off, lower case, letters only.
const letters = (word: string) =>
  word
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/ł/g, "l")
    .replace(/ß/g, "ss")
    .replace(/[^a-z]/g, "");

/** Spelling-for-sound rules, general ones only, with no person's name in them: chr→kr, rz→r (Polish Krzys sounds near Chris)… */
const sounded = (word: string) =>
  letters(word)
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

/**
 * A rough sound key for one word of a name, for matching a misheard name across spellings: accents off; chr→kr, rz→r (Polish
 * Krzys sounds near Chris), sz→s, cz→c, ph→f, ck→k, soft c→s, other c, q→k, x→ks, w→v, z→s, y→i; h after the first letter goes,
 * doubles go, then vowels after the first letter. "Zuzanna" and "Susannah" share one (ssn); so do "Chris" and "Krzys" (krs); "Sean"
 * (sn) does not. General rules, no person's name in them.
 */
export function soundKey(word: string): string {
  const text = sounded(word);
  return `${text.slice(0, 1)}${text.slice(1).replace(/h/g, "").replace(/(.)\1+/g, "$1").replace(/[aeiou]/g, "")}`;
}

/** The same key with its vowels kept: "John" jon, "Joan" joan, "Sarah" sara. Tells apart names the consonants alone merge. */
function voicedKey(word: string): string {
  const text = sounded(word);
  return `${text.slice(0, 1)}${text.slice(1).replace(/h/g, "").replace(/(.)\1+/g, "$1")}`;
}

/** Edits (insert, delete, change one letter) from a to b. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) row.push(Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)));
    previous = row;
  }
  return previous[b.length]!;
}

/**
 * Two words sound alike: the same consonant key, and vowels that differ by at most one edit per four letters. "Chris"/"Krzys",
 * "Susannah"/"Zuzanna" and "Suzanne"/"Zuzanna" do; "John"/"Joan" (jon, joan) do not. "Sara"/"Sarah" do, as they are said the same.
 */
export function soundsAlike(a: string, b: string): boolean {
  const key = soundKey(a);
  if (key.length < 2 || key !== soundKey(b)) return false;
  const [x, y] = [voicedKey(a), voicedKey(b)];
  return editDistance(x, y) <= Math.floor(Math.min(x.length, y.length) / 4);
}

/**
 * How a heard word matches a known first name: "exact" (any case), "sound" (another spelling that sounds alike: Susannah for
 * Zuzanna), "short" (the literal start of it: Alex for Alexandra, Max for Maxwell) or "sound-short" (another spelling of its
 * start: Chris, as STT writes the short form Krzys, for Krzysztof). Null for none. A short form needs 3 or more letters.
 */
export type NameMatch = "exact" | "sound" | "short" | "sound-short";

export function matchFirstName(heard: string, first: string): NameMatch | null {
  const [h, k] = [letters(heard), letters(first)];
  if (h.length < 2 || k.length < 2) return null;
  if (h === k) return "exact";
  if (soundsAlike(heard, first)) return "sound";
  if (h.length < 3 || h.length >= k.length) return null;
  if (k.startsWith(h)) return "short";
  for (let end = 3; end < first.length; end += 1) if (soundsAlike(heard, first.slice(0, end))) return "sound-short";
  return null;
}

/** The known names as people: a one-word name dropped when a longer one starts with it ("Krzysztof" beside "Krzysztof Nowak"). */
function people(known: readonly string[]): string[] {
  const names = normalizeNames(known);
  return names.filter((name) => name.includes(" ") || !names.some((other) => other.toLowerCase().startsWith(`${name.toLowerCase()} `)));
}

/**
 * Known people whose first name the heard word could be, and how. An exact first name rules out plain short forms of others: with
 * Alex Smith and Alexandra Jones known, "Alex" is Alex Smith. A short form spelled another way still counts (with Chris Lee and
 * Krzysztof Nowak known, "Chris" may be either: STT writes the short form Krzys as Chris).
 */
export function nameMatches(heard: string, known: readonly string[]): { name: string; how: NameMatch }[] {
  const found: { name: string; how: NameMatch }[] = [];
  for (const name of people(known)) {
    const how = matchFirstName(heard, name.split(" ")[0] ?? "");
    if (how) found.push({ name, how });
  }
  return found.some((match) => match.how === "exact") ? found.filter((match) => match.how !== "short") : found;
}

/** Known names whose first word the heard word could be: "Chris" → Chris Lee, Krzysztof Nowak. */
export function namesSoundingLike(heard: string, known: readonly string[]): string[] {
  return nameMatches(heard, known).map((match) => match.name);
}

export type NameAmbiguity = { heard: string; matches: string[] };

// Words after which the next word is a person: "send chris…", "message to chris", "call krzys", "find chris", "chat with chris".
const PERSON_BEFORE = /^(?:send|message|dm|text|e-?mail|mail|reply|respond|tell|ping|call|ring|phone|invite|share|forward|find|open|show|search|ask|chat|talk|with|to|for|from|cc|bcc|and|or)$/i;
// After a possessive, words that make it a person: "chris's chat", "Krzys's DM".
const PERSON_AFTER = /^(?:chat|chats|dm|dms|messages?|thread|conversation|inbox|profile|number|email|calendar)$/i;
const WORD = /[\p{L}][\p{L}'’-]*/gu;
const POSSESSIVE = /['’]s$/i;

type Token = { word: string; start: number; end: number; person: boolean };

/**
 * The words of a request that may be a person's name: a capitalised word (STT capitalises names), or any word, in any case, where a
 * person goes (after "send", "call", "find", "with", "to"…, or before "'s chat"). A possessive 's is left off the word.
 */
function nameTokens(text: string): Token[] {
  const words = [...text.matchAll(WORD)].map((match) => ({ raw: match[0], start: match.index ?? 0 }));
  const tokens: Token[] = [];
  words.forEach(({ raw, start }, index) => {
    const possessive = POSSESSIVE.test(raw);
    const word = raw.replace(POSSESSIVE, "").replace(/['’-]+$/, "");
    if (word.length < 3 || NOT_HEARD.test(word)) return;
    const before = words[index - 1]?.raw ?? "";
    const after = words[index + 1]?.raw ?? "";
    const slot = PERSON_BEFORE.test(before) || (possessive && PERSON_AFTER.test(after));
    const capital = /^\p{Lu}/u.test(word);
    if (!capital && !slot) return;
    tokens.push({ word, start, end: start + word.length, person: slot });
  });
  return tokens;
}

/**
 * Names in a request that could be more than one known person: a word that may be a name (nameTokens: capitalised, or where a
 * person goes, in any case) matching two or more known people, unless the request also names one in full (a surname). "send
 * Chris hi" or "send chris hi" with Chris Lee and Krzysztof Nowak known → Chris: both. "send Chris Lee hi" → none.
 */
export function nameAmbiguities(request: string, known: readonly string[]): NameAmbiguity[] {
  const lower = request.toLowerCase();
  const found: NameAmbiguity[] = [];
  for (const { word } of nameTokens(request)) {
    const matches = namesSoundingLike(word, known);
    if (matches.length < 2) continue;
    // A full known name in the request ("Chris Lee") settles it.
    if (matches.some((name) => name.includes(" ") && lower.includes(name.toLowerCase()))) continue;
    const heard = /^\p{Lu}/u.test(word) ? word : cap(word);
    if (!found.some((item) => item.heard.toLowerCase() === heard.toLowerCase())) found.push({ heard, matches: matches.slice(0, 4) });
  }
  return found;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Recent text checked for a person the user meant: newest last. */
export const RECENT_TEXTS_MAX = 24;

/**
 * The one person of an ambiguity the user's recent requests were about, or null. The newest recent text that names any of them
 * decides: by full name, or by a word of the name that is not the heard word and no other match shares ("Nowak", "Krzysztof",
 * "Lee"), never by one that sounds like the heard word (heard Krzys: a recent "Chris" says nothing about Chris Lee). When it
 * names two or more, or none does, null: Bee asks. Per request only: nothing is stored.
 */
export function recentChoice(ambiguity: NameAmbiguity, recent: readonly string[]): string | null {
  const heard = letters(ambiguity.heard);
  const marks = ambiguity.matches.map((name) => {
    // Never the heard word, nor a word that sounds like it: "Chris" in a recent "Which Chris…?" is the same doubt, not Chris Lee.
    const words = name.split(/[\s]+/).filter((word) => letters(word).length >= 3 && letters(word) !== heard && !soundsAlike(word, ambiguity.heard));
    const own = words.filter((word) => !ambiguity.matches.some((other) => other !== name && other.split(/\s+/).some((part) => letters(part) === letters(word))));
    const terms = [...new Set([name, ...own])].map((term) => new RegExp(`(?<![\\p{L}])${escapeRegExp(term)}(?![\\p{L}])`, "iu"));
    return { name, terms };
  });
  for (const text of recent.slice(-RECENT_TEXTS_MAX).reverse()) {
    const named = marks.filter((mark) => mark.terms.some((term) => term.test(text)));
    if (named.length === 1) return named[0]!.name;
    if (named.length > 1) return null;
  }
  return null;
}

/** A name Bee settled from the user's recent requests: "Chris" in this request means Krzysztof Nowak. */
export type ResolvedName = { heard: string; name: string };

/**
 * The transcript with a misheard name put in the known spelling, before the wake word and the request are read: "send Chris a
 * message" with only Krzysztof Nowak known → "send Krzysztof a message"; "Susannah" → "Zuzanna" with only Zuzanna known. Only a
 * word that may be a name (nameTokens), only when exactly one known person matches it, and only by sound (another spelling): an
 * exact or literal short form ("Alex" for Alexandra) stays as heard. With Chris Lee and Krzysztof Nowak both known, "Chris" stays
 * "Chris", and the request asks which one. Nothing is stored.
 */
export function remapHeardNames(
  text: string,
  known: readonly string[],
  options: { skip?: (word: string) => boolean } = {},
): { text: string; changes: { from: string; to: string }[] } {
  if (known.length === 0 || !text) return { text, changes: [] };
  const changes: { from: string; to: string; start: number; end: number }[] = [];
  for (const token of nameTokens(text)) {
    // A word the caller knows is something else (an app name: core/desktop-actions.ts isKnownApp) stays as heard.
    if (options.skip?.(token.word)) continue;
    const matches = nameMatches(token.word, known);
    const match = matches.length === 1 ? matches[0] : undefined;
    if (!match || (match.how !== "sound" && match.how !== "sound-short")) continue;
    const to = match.name.split(" ")[0] ?? "";
    if (to && to !== token.word) changes.push({ from: token.word, to, start: token.start, end: token.end });
  }
  let out = text;
  for (const change of [...changes].reverse()) out = `${out.slice(0, change.start)}${change.to}${out.slice(change.end)}`;
  return { text: out, changes: changes.map(({ from, to }) => ({ from, to })) };
}

/** Terms to bias speech-to-text toward (core/transcribe.ts): known names, newest first, then their first names. */
export const STT_TERMS_MAX = 50;
export function sttTerms(known: readonly string[]): string[] {
  const names = normalizeNames(known).reverse();
  const firsts = names.map((name) => name.split(" ")[0] ?? "").filter((word) => word.length >= 3);
  const seen = new Set<string>();
  return [...names, ...firsts].filter((term) => (seen.has(term.toLowerCase()) ? false : (seen.add(term.toLowerCase()), true))).slice(0, STT_TERMS_MAX);
}

/** The people a name could be, as a list to choose from: "Chris Lee or Krzysztof Nowak", "A, B or C". */
export function nameChoices(options: readonly string[]): string {
  return options.length <= 2 ? options.join(" or ") : `${options.slice(0, -1).join(", ")} or ${options.at(-1)}`;
}

/** The question Bee asks for the first ambiguous name: "Which Chris: Chris Lee or Krzysztof Nowak?" */
export function whichNameQuestion(ambiguity: NameAmbiguity): string {
  return `Which ${ambiguity.heard}: ${nameChoices(ambiguity.matches)}?`;
}

/**
 * The names block for the AI, newest first, or "" when there are none. With the request, a line for each name in it that could
 * be more than one known person, so the AI asks rather than picks, unless Bee settled it from the user's recent requests
 * (resolved): then a line says which person that is.
 */
export function knownNamesBlock(names: readonly string[], request?: string, resolved: readonly ResolvedName[] = []): string {
  const list = normalizeNames(names).slice(-PROMPT_NAMES_MAX).reverse();
  if (list.length === 0) return "";
  const block = `Names the user has taught Bee (spell them this way; a misheard name, such as Susannah for Zuzanna, may be one of these; when it could be more than one of them, ask which): ${list.join(", ")}.`;
  const settled = (heard: string) => resolved.some((item) => item.heard.toLowerCase() === heard.toLowerCase());
  const unclear = request ? nameAmbiguities(request, list).filter((item) => !settled(item.heard)) : [];
  const lines = [
    ...resolved.map(({ heard, name }) => `"${heard}" in this request means ${name}: the user's recent requests were about ${name}. If the user says otherwise, follow them.`),
    ...unclear.map(({ heard, matches }) => `"${heard}" in this request could be ${matches.join(" or ")}. Ask the user which one before acting on that name; never pick one yourself.`),
  ];
  return [block, ...lines].join("\n");
}
