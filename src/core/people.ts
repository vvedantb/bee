import { KNOWN_NAMES_MAX, normalizeNames } from "./known-names";

// What Bee knows about a person beyond the name (core/known-names.ts holds the names): a work email and the topics the user
// usually talks to them about. Typed in Settings → Memory, one person per line ("Zuzanna Moody, zuzanna@example.com, pricing,
// contracts"), and kept on this computer. The email opens the person's Teams chat by link, with no search to mishear or mistype;
// it is never sent to the AI. The topics go with the names to the AI that writes meeting notes. Pure: no Electron, no fs.

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

/**
 * The Memory tab's text as the lists to save. Each line is a name, then (after commas) an email and the usual topics, in any
 * order: "Sam Lee", "Sam Lee, sam@example.com", "Sam Lee, sam@example.com, rotas, invoices".
 */
export function peopleFromText(text: string): { names: string[]; people: Person[] } {
  const rows = text.split(/\r?\n/).map((line) => {
    const [name = "", ...rest] = line.split(",").map((part) => part.trim());
    const email = rest.find((part) => cleanEmail(part) !== null);
    const topics = rest.filter((part) => part !== email && part !== "").join(", ");
    return { name, ...(email ? { email } : {}), ...(topics ? { topics } : {}) };
  });
  const names = normalizeNames(rows.map((row) => row.name));
  const kept = new Set(names.map(key));
  return { names, people: normalizePeople(rows).filter((person) => kept.has(key(person.name))) };
}

/** The lists as the Memory tab's text: every known name on its own line, with its email and topics when Bee has them. */
export function peopleText(names: readonly string[], people: readonly Person[]): string {
  const details = new Map(people.map((person) => [key(person.name), person]));
  return names
    .map((name) => {
      const person = details.get(key(name));
      return [name, person?.email, person?.topics].filter(Boolean).join(", ");
    })
    .join("\n");
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
