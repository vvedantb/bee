import { chipLabel } from "./link-rank";
import { safeExternalUrl } from "./url-safety";

// Finds website references in a spoken line or a tip, for suggestion chips. Nothing here opens anything.

// id and domain are the host without www (dismiss and dedupe use id). url may be a deep link; label is what the chip shows.
export type LinkChip = { id: string; domain: string; url: string; label: string };

export const MAX_CHIPS = 5;
const MAX_TEXT = 4000;

const TLDS = new Set(
  ("com org net io dev ai app co cloud tech me gg sh so xyz info edu gov uk us au ca de fr in jp nl se ch be at it es nz ie pt br mx kr cn tw hk sg za " +
    "eu ru pl dk no fi is gr cz").split(" "),
);
// Also common English words or file endings: bare "end.it" needs a lowercase TLD, and spoken forms never use them.
const WEAK_TLDS = new Set(["in", "it", "at", "be", "so", "me", "is", "no", "us", "sh"]);
// Bare "setup.sh" or "libc.so" reads as a file, so these need www., a scheme or the spoken form.
const FILE_LIKE_TLDS = new Set(["sh", "so"]);
// Words that can sit before a spoken "dot" in normal sentences.
const STOPWORDS = new Set(
  ("the a an this that these those my your our their his her its to of in on at for with and or but is it we you i they he she one no not any some each just then dot").split(" "),
);

// Curated names Luna or a speaker may say without a domain. Keep this short.
const SERVICES: ReadonlyArray<{ pattern: RegExp; domain: string; url: string }> = [
  { pattern: /\bgit\s?hub\b/i, domain: "github.com", url: "https://github.com/" },
  { pattern: /\bvercel(?:\s+dashboard)?\b/i, domain: "vercel.com", url: "https://vercel.com/" },
  { pattern: /\bconvex\s+dashboard\b/i, domain: "dashboard.convex.dev", url: "https://dashboard.convex.dev/" },
  { pattern: /\bstripe\s+dashboard\b/i, domain: "dashboard.stripe.com", url: "https://dashboard.stripe.com/" },
  { pattern: /\b(?:(?:open|in|on|to|from|into|use|using|via)\s+notion|notion\s+(?:dashboard|page|pages|workspace|doc|docs|database|board|app))\b/i, domain: "notion.so", url: "https://www.notion.so/" },
  { pattern: /\bfigma\b/i, domain: "figma.com", url: "https://www.figma.com/" },
  { pattern: /\bgoogle\s+drive\b/i, domain: "drive.google.com", url: "https://drive.google.com/" },
];

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
// Left edge: not inside a word, an email, a path or a longer dotted name. Right edge: not followed by more name.
const HOST = new RegExp(`(?<![\\w@./-])(${LABEL}(?:(?:\\s*\\.\\s*|\\s+dot\\s+)${LABEL})+)(?![\\w@-]|\\.\\w)(\\/[^\\s<>"')\\]]*)?`, "gi");
const EXPLICIT = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
const TRAILING = /[.,;:!?]+$/;

type Hit = { index: number; chip: LinkChip };

function chipFor(url: string): LinkChip | null {
  const safe = safeExternalUrl(url);
  if (!safe) return null;
  const domain = new URL(safe).hostname.toLowerCase().replace(/^www\./, "");
  return { id: domain, domain, url: safe, label: chipLabel(safe) };
}

function mask(text: string, start: number, length: number): string {
  return text.slice(0, start) + " ".repeat(length) + text.slice(start + length);
}

/** A bare or spoken host ("convex.dev", "convex dot com") as a chip, or null when it looks like prose or a file. */
function hostChip(match: RegExpExecArray): LinkChip | null {
  const raw = match[1] ?? "";
  // Spoken "dot" or speech-to-text spacing around the dot ("convex . dev", "convex. dev").
  const spoken = /\sdot\s|\s\.|\.\s/i.test(raw);
  const labels = raw.split(/\s*\.\s*|\s+dot\s+/i);
  const tldRaw = labels[labels.length - 1] ?? "";
  const tld = tldRaw.toLowerCase();
  if (!TLDS.has(tld)) return null;
  const hostLabels = labels.map((label) => label.toLowerCase());
  const registrable = hostLabels[hostLabels.length - 2] ?? "";
  if (registrable.length < 2 || /^\d+$/.test(registrable)) return null;
  if (hostLabels.some((label) => /^\d+$/.test(label))) return null;
  const hasPath = Boolean(match[2]);
  const www = hostLabels[0] === "www";
  if (WEAK_TLDS.has(tld) && tldRaw !== tld) return null;
  if (spoken) {
    if (WEAK_TLDS.has(tld)) return null;
    // "end. Com" starts a sentence: a spaced dot needs a lowercase TLD.
    if (!/\sdot\s/i.test(raw) && tldRaw !== tld) return null;
    if (hostLabels.slice(0, -1).some((label) => STOPWORDS.has(label))) return null;
  } else if (FILE_LIKE_TLDS.has(tld) && !www && !hasPath) return null;
  const path = (match[2] ?? "").replace(TRAILING, "");
  return chipFor(`https://${hostLabels.join(".")}${path}`);
}

/** Chips for the websites a piece of text refers to: URLs, bare domains, spoken "x dot com" and a few named services. */
export function detectLinks(input: string): LinkChip[] {
  let text = input.slice(0, MAX_TEXT);
  const hits: Hit[] = [];

  for (const match of text.matchAll(EXPLICIT)) {
    const chip = chipFor(match[0].replace(TRAILING, ""));
    if (chip) hits.push({ index: match.index, chip });
  }
  for (const hit of [...text.matchAll(EXPLICIT)]) text = mask(text, hit.index, hit[0].length);

  for (const match of text.matchAll(HOST)) {
    const chip = hostChip(match);
    if (!chip) continue;
    hits.push({ index: match.index, chip });
  }
  // Mask every dotted or spoken host candidate, accepted or not, so a service name inside one ("github.js") stays quiet.
  for (const hit of [...text.matchAll(HOST)]) text = mask(text, hit.index, hit[0].length);

  for (const service of SERVICES) {
    const match = service.pattern.exec(text);
    if (match) hits.push({ index: match.index, chip: { id: service.domain, domain: service.domain, url: service.url, label: service.domain } });
  }

  hits.sort((a, b) => a.index - b.index);
  return mergeChips([], hits.map((hit) => hit.chip));
}

/** Add incoming chips after the existing ones: deduped by domain, at most MAX_CHIPS in all. */
export function mergeChips(existing: readonly LinkChip[], incoming: readonly LinkChip[]): LinkChip[] {
  const merged = [...existing];
  for (const chip of incoming) {
    if (merged.length >= MAX_CHIPS) break;
    if (!merged.some((known) => known.id === chip.id)) merged.push(chip);
  }
  return merged;
}

/** The chips still on screen this turn. */
export function visibleChips(chips: readonly LinkChip[], dismissedIds: readonly string[]): LinkChip[] {
  return chips.filter((chip) => !dismissedIds.includes(chip.id)).slice(0, MAX_CHIPS);
}
