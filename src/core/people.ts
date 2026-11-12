import { KNOWN_NAMES_MAX, isPerson, normalizeNames } from "./known-names";

// What Bee knows about a person beyond the name (core/known-names.ts holds the names): the topics they usually talk about, and a
// work email when Bee has one. Bee keeps this by itself, in its settings file on this computer; no screen shows or edits it. The
// topics come from meetings whose transcript names its speakers (live captions): the notes AI lists each speaker's topics, Bee
// files them here and leaves them out of the note. They go with the names to the AI that writes the next notes. An email opens the
// person's Teams chat by link; it is never sent to the AI. Pure: no Electron, no fs.

export type Person = { name: string; email?: string; topics?: string };

/** One person's topics, at most this long. */
export const TOPICS_MAX_CHARS = 200;
const EMAIL_MAX_CHARS = 254;
// One address, nothing else: no spaces, quotes, angle brackets or separators that could carry a second address or a link part.
const EMAIL = /^[\p{L}\p{N}._%+'-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+$/u;

const key = (name: string) => name.toLowerCase();

/** The email as stored (trimmed, lower case), or null when it is not one plain address. */
export function cleanEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  return email.length <= EMAIL_MAX_CHARS && EMAIL.test(email) ? email : null;
}

const cleanTopics = (raw: string) => raw.replace(/\s+/g, " ").trim().slice(0, TOPICS_MAX_CHARS).trim();

/**
 * The details as stored: one entry per name (any case; the last wins), names cleaned like the known names, a bad email dropped,
 * entries with neither an email nor topics dropped.
 */
export function normalizePeople(people: readonly Person[]): Person[] {
  const byName = new Map<string, Person>();
  for (const raw of people) {
    const [name] = normalizeNames([raw.name]);
    if (!name) continue;
    const email = raw.email ? cleanEmail(raw.email) : null;
    const topics = raw.topics ? cleanTopics(raw.topics) : "";
    // A repeat of the name with no details keeps the details already read.
    if (!email && !topics) continue;
    byName.delete(key(name));
    byName.set(key(name), { name, ...(email ? { email } : {}), ...(topics ? { topics } : {}) });
  }
  return [...byName.values()].slice(-KNOWN_NAMES_MAX);
}

const TOPICS_PER_MEETING = 3;
const TOPIC_MAX_CHARS = 40;

const topicList = (topics: string) =>
  topics
    .split(/[;,]/)
    .map((topic) => topic.replace(/\s+/g, " ").trim().replace(/[.]+$/, ""))
    .filter((topic) => topic.length > 0);

/** The person's topics with fresh ones put first: no repeats (any case), whole topics only, within TOPICS_MAX_CHARS. The oldest drop off. */
export function mergeTopics(known: string | undefined, fresh: string): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const topic of [...topicList(fresh), ...topicList(known ?? "")]) {
    if (topic.length > TOPIC_MAX_CHARS || seen.has(key(topic))) continue;
    if ([...kept, topic].join(", ").length > TOPICS_MAX_CHARS) break;
    seen.add(key(topic));
    kept.push(topic);
  }
  return kept.join(", ");
}

/** What a meeting taught Bee about one person: the name as the call showed it, and what they talked about. */
export type LearnedPerson = { name: string; topics?: string };

/** The details with what Bee just learned merged in: topics added to the person's own, an email never touched. */
export function learnedPeople(people: readonly Person[], learned: readonly LearnedPerson[]): Person[] {
  const byName = new Map(normalizePeople(people).map((person) => [key(person.name), person]));
  for (const raw of learned) {
    const [name] = normalizeNames([raw.name]);
    if (!name || !raw.topics) continue;
    const old = byName.get(key(name));
    if (!old && !isPerson(name)) continue;
    const topics = mergeTopics(old?.topics, raw.topics);
    if (!topics) continue;
    byName.delete(key(name));
    byName.set(key(name), { ...old, name: old?.name ?? name, topics });
  }
  return [...byName.values()].slice(-KNOWN_NAMES_MAX);
}

/** Added to the notes AI's rules when the transcript names its speakers: one more section, which Bee files and never shows. */
export const PEOPLE_SECTION_RULES = [
  'After Topics, add a fourth section, "## People": one bullet for each speaker who said something of substance, as "- Name: topic; topic".',
  "Use the speaker's name exactly as the transcript gives it. Give at most three topics of one to four words each, taken only from what that speaker said. Leave out a speaker with nothing of substance.",
].join("\n");

/**
 * The notes AI's reply without its People section, and what that section says about the meeting's own speakers. A name that is not
 * a speaker in the transcript is dropped: Bee learns only about people the call itself named.
 */
export function splitPeopleSection(body: string, speakers: readonly string[]): { body: string; people: LearnedPerson[] } {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => /^##\s+people\s*$/i.test(line));
  if (start === -1) return { body, people: [] };
  const next = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  const end = next === -1 ? lines.length : next;
  const named = new Map(speakers.map((speaker) => [key(speaker.trim()), speaker.trim()]));
  const people: LearnedPerson[] = [];
  for (const line of lines.slice(start + 1, end)) {
    const match = /^\s*[-*]\s+(?:\*\*)?([^:*]+?)(?:\*\*)?\s*:\s*(.+)$/.exec(line);
    const name = match ? named.get(key((match[1] ?? "").trim())) : undefined;
    if (!name || !match) continue;
    const topics = topicList(match[2] ?? "").filter((topic) => topic.length <= TOPIC_MAX_CHARS).slice(0, TOPICS_PER_MEETING).join(", ");
    if (topics) people.push({ name, topics });
  }
  return { body: [...lines.slice(0, start), ...lines.slice(end)].join("\n").trim(), people };
}

/** The email saved for exactly this name (any case), else null. A name that only sounds or starts alike is someone else. */
export function emailFor(name: string, people: readonly Person[]): string | null {
  const wanted = key(name.replace(/\s+/g, " ").trim());
  return people.find((person) => key(person.name) === wanted)?.email ?? null;
}

/** The recipe's email field for this name, when Bee has one: spread into a Teams message (core/teams-recipe.ts). */
export function chatEmail(name: string, people: readonly Person[] = []): { email?: string } {
  const email = emailFor(name, people);
  return email ? { email } : {};
}

/** The link that opens the one-to-one Teams chat with this address in the Teams app, or null for anything but one plain address. */
export function teamsChatLink(raw: string): string | null {
  const email = cleanEmail(raw);
  return email ? `msteams:/l/chat/0/0?users=${encodeURIComponent(email)}` : null;
}

/** For the AI that writes meeting notes: the people the user knows and what they usually talk about. Names and topics only. */
export function peopleBlock(names: readonly string[], people: readonly Person[]): string {
  const list = normalizeNames(names).slice(-60);
  if (list.length === 0) return "";
  const details = new Map(people.map((person) => [key(person.name), person]));
  const lines = list.map((name) => {
    const topics = details.get(key(name))?.topics;
    return topics ? `- ${name} (usually: ${topics})` : `- ${name}`;
  });
  return [
    "People the user knows, spelled the way the user spells them:",
    ...lines,
    "Spell these names this way. A name in the transcript that is plainly a mishearing of exactly one of them (Susannah for Zuzanna) is that person; when it could be more than one, or you are not sure, keep the name as heard.",
    "The topics are background only. Never name someone as a speaker or an owner because of the topic alone.",
  ].join("\n");
}
