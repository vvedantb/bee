import { isFiller, isQuestion } from "./steering";

// When Luna gets the web_search tool, and where Anthropic should search from. Pure and local: no model call, so it adds no latency.
// The rule is conservative: only a turn that is clearly arithmetic, a definition or a stable fact goes without search.

// Fresh or current facts: news, dates relative to today, live data, office holders, releases.
const CURRENT =
  /\b(?:news|headlines?|today|tonight|tomorrow|yesterday|this (?:morning|afternoon|evening|week|weekend|month|year)|next (?:week|weekend|month)|last (?:night|week|weekend)|right now|at the moment|currently|current|latest|recent(?:ly)?|scores?|won|wins?|winners?|election|polls?|prices?|stocks?|share price|exchange rates?|interest rates?|inflation|weather|forecast|temperature|rain|snow|traffic|closures?|closed|delays?|delayed|strikes?|disruptions?|cancell?ed|opening (?:hours|times)|released?|launch(?:ed|es)?|announce(?:d|ment)?|ceo|president|prime minister|chancellor|minister|mayor|20\d\d)\b/i;
const CURRENCY = "(?:dollars?|euros?|pounds?|yen|usd|gbp|eur)";
// Currency conversion needs today's rate.
const CONVERSION = new RegExp(`\\b${CURRENCY}\\b.*\\b(?:to|into|in)\\b.*\\b${CURRENCY}\\b`, "i");

const NUMBER =
  "(?:\\d[\\d,.]*|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|half|quarter)";
// One or more number words, e.g. "eighteen thousand" or "2,500".
const AMOUNT = `${NUMBER}(?:[\\s-]+(?:and\\s+)?${NUMBER})*`;
const ARITHMETIC = new RegExp(
  [
    `${AMOUNT}\\s*(?:%|percent|per cent)\\s*of\\s*${AMOUNT}`,
    `${AMOUNT}\\s*(?:\\+|-|\\*|/|x|×|÷|plus|minus|times|multiplied by|divided by|over)\\s*${AMOUNT}`,
    `(?:square root|cube root|half|a third|a quarter|sum|average|total) of\\s*${AMOUNT}`,
    `${AMOUNT}\\s*(?:squared|cubed|to the power of)`,
    `what percent(?:age)? is ${AMOUNT}`,
  ].join("|"),
  "i",
);
const DEFINITION =
  /\b(?:define|definition of|meaning of|what does [\w'-]+(?: [\w'-]+){0,2} mean|what is meant by|how do you spell|spell|synonyms? (?:of|for)|antonyms? (?:of|for)|plural of|past tense of|translate)\b/i;
const STABLE_FACT =
  /\b(?:capital (?:city )?of|who (?:wrote|painted|invented|discovered|composed)|boiling point|freezing point|speed of light|chemical (?:symbol|formula)|how many (?:legs|sides|bones|days|hours|minutes|seconds|weeks|grams|ounces|inches|feet|metres|meters|miles|kilometres|kilometers) (?:in|does|do|are)|how many \w+ in an? \w+)\b/i;

/** True when a line asks for something that can change, so a search may be needed. */
export function isCurrent(line: string): boolean {
  return CURRENT.test(line) || CONVERSION.test(line);
}

/** True when a line is answered without fresh facts: a sum, a definition, a stable fact. */
export function isStable(line: string): boolean {
  return ARITHMETIC.test(line) || DEFINITION.test(line) || STABLE_FACT.test(line);
}

/**
 * Whether Luna gets the web_search tool this turn. lines: the turn's lines. context: earlier lines and the last answer's tips.
 * searched: the last answer came from a web search. Search when a line asks for current facts, when a question is neither a sum
 * nor a definition nor a stable fact, or when the turn follows up a searched or current-events answer and is not all sums. Plain
 * talk with no question and no follow-up gets no search: the notes answer it.
 */
export function needsWebSearch(args: { lines: readonly string[]; context?: readonly string[]; searched?: boolean }): boolean {
  const lines = args.lines.filter((line) => !isFiller(line));
  if (lines.some(isCurrent)) return true;
  if (lines.some((line) => isQuestion(line) && !isStable(line))) return true;
  const followUp = args.searched === true || (args.context ?? []).some(isCurrent);
  return followUp && !lines.every(isStable);
}

/** Anthropic web search's userLocation: an approximate place, so results are local (London news, UK prices). */
export type SearchLocation = { type: "approximate"; city?: string; country?: string; timezone?: string };

// Time zones whose city is a fair guess at where the user is, with their ISO 3166-1 alpha-2 country.
const ZONE_COUNTRY: Record<string, string> = {
  "Europe/London": "GB",
  "Europe/Belfast": "GB",
  "Europe/Dublin": "IE",
  "Europe/Paris": "FR",
  "Europe/Berlin": "DE",
  "Europe/Madrid": "ES",
  "Europe/Rome": "IT",
  "Europe/Amsterdam": "NL",
  "Europe/Brussels": "BE",
  "Europe/Lisbon": "PT",
  "Europe/Zurich": "CH",
  "Europe/Vienna": "AT",
  "Europe/Stockholm": "SE",
  "Europe/Oslo": "NO",
  "Europe/Copenhagen": "DK",
  "Europe/Helsinki": "FI",
  "Europe/Warsaw": "PL",
  "America/New_York": "US",
  "America/Chicago": "US",
  "America/Denver": "US",
  "America/Los_Angeles": "US",
  "America/Phoenix": "US",
  "America/Toronto": "CA",
  "America/Vancouver": "CA",
  "America/Mexico_City": "MX",
  "America/Sao_Paulo": "BR",
  "Asia/Kolkata": "IN",
  "Asia/Calcutta": "IN",
  "Asia/Tokyo": "JP",
  "Asia/Singapore": "SG",
  "Asia/Hong_Kong": "HK",
  "Asia/Shanghai": "CN",
  "Asia/Dubai": "AE",
  "Australia/Sydney": "AU",
  "Australia/Melbourne": "AU",
  "Pacific/Auckland": "NZ",
  "Africa/Johannesburg": "ZA",
};
// An IANA zone with a place in it ("Europe/London"), not "UTC" or "Etc/GMT+1".
const PLACE_ZONE = /^(?!Etc\/)[A-Z][A-Za-z_-]+(?:\/[A-Za-z_-]+)+$/;

function localeCountry(locale: string | undefined): string | undefined {
  if (!locale) return undefined;
  try {
    const region = new Intl.Locale(locale).region;
    return region && /^[A-Z]{2}$/.test(region) ? region : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The user's approximate place from the system time zone and locale. A known zone gives the city and country (Europe/London →
 * London, GB); otherwise the locale's region gives the country. Undefined when neither says anything.
 */
export function searchLocation(args: { timeZone?: string; locale?: string }): SearchLocation | undefined {
  const zone = args.timeZone && PLACE_ZONE.test(args.timeZone) ? args.timeZone : undefined;
  const zoneCountry = zone ? ZONE_COUNTRY[zone] : undefined;
  const country = zoneCountry ?? localeCountry(args.locale);
  const city = zoneCountry && zone ? zone.split("/").at(-1)?.replace(/_/g, " ") : undefined;
  if (!zone && !country) return undefined;
  return { type: "approximate", ...(city ? { city } : {}), ...(country ? { country } : {}), ...(zone ? { timezone: zone } : {}) };
}
