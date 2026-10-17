import type { LinkChip } from "./link-suggest";
import { safeExternalUrl } from "./url-safety";

// Personalises link chips: the detector (link-suggest.ts) finds the sites, history search finds the pages the user visited
// there, and Jev picks one (or says no link helps). Pure logic: search and Jev are injected, so no Electron or network here.
// Every failure keeps the plain detector chip. Only a clear "no" from Jev removes one.

/** Jev scores run 0–3. A suggestion needs the "should we suggest" score and the chosen URL's score at or above this. */
export const LINK_MIN_SCORE = 2;
/** One budget for the whole vmem + Jev enrichment of a turn. */
export const ENRICH_TIMEOUT_MS = 2500;
export const MAX_HISTORY_CANDIDATES = 5;
const MAX_LABEL_SEGMENTS = 3;
const MAX_SEGMENT_CHARS = 24;
const CACHE_SIZE = 50;

export type HistoryHit = { url: string; title: string; source: string };

/** The URLs Jev chooses between for one chip: history pages first, the plain candidate last. */
export type LinkCandidate = { domain: string; urls: Array<{ url: string; title: string }> };

/** Jev scores (0–3, null when missing or invalid). urls lines up with LinkCandidate.urls. */
export type LinkDecision = { suggest: number | null; urls: Array<number | null> };

export type EnrichDeps = {
  searchHistory: (query: string, domain: string, signal: AbortSignal) => Promise<HistoryHit[]>;
  decide: (turn: string, candidate: LinkCandidate, signal: AbortSignal) => Promise<LinkDecision>;
};

/** "vercel.com › vibot › logs": host without www, then up to three path segments. No query, hash or empty segments. */
export function chipLabel(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const host = parsed.hostname.replace(/^www\./i, "");
  const segments = parsed.pathname
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => {
      let text = segment;
      try {
        text = decodeURIComponent(segment);
      } catch {
        // Keep the raw segment.
      }
      return text.length > MAX_SEGMENT_CHARS ? `${text.slice(0, MAX_SEGMENT_CHARS - 1)}…` : text;
    })
    .slice(0, MAX_LABEL_SEGMENTS);
  return [host, ...segments].join(" › ");
}

/**
 * Personalising needs the toggle and the Gateway key for Jev. Anything less: plain chips.
 * A vmem connector is optional: it only feeds history pages to Jev, which scores the plain domain chip without it.
 */
export function canPersonalise(args: { enabled: boolean; hasVmem?: boolean; hasGatewayKey: boolean }): boolean {
  return args.enabled && args.hasGatewayKey;
}

function validScore(score: number | null | undefined): number | null {
  return typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 3 ? score : null;
}

/** True when the URL's host is the domain, ignoring www. */
export function sameSite(url: string, domain: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "") === domain.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
}

/** The candidate URLs for a chip: safe, deduped history pages (at most five), then the chip's own URL. */
export function buildCandidate(chip: LinkChip, hits: readonly HistoryHit[]): LinkCandidate {
  const urls: LinkCandidate["urls"] = [];
  // The chip's own URL is the plain candidate and goes last, so a history page that repeats it is not listed twice.
  const seen = new Set<string>([chip.url]);
  for (const hit of hits) {
    if (urls.length >= MAX_HISTORY_CANDIDATES) break;
    const safe = safeExternalUrl(hit.url);
    if (!safe || seen.has(safe) || !sameSite(safe, chip.domain)) continue;
    seen.add(safe);
    urls.push({ url: safe, title: hit.title });
  }
  urls.push({ url: chip.url, title: chip.domain });
  return { domain: chip.domain, urls };
}

/**
 * Apply Jev's scores to one chip. null = drop it (Jev says no link helps).
 * Missing or invalid answers keep the plain chip: only a valid suggest score below the cut-off drops.
 */
export function applyDecision(chip: LinkChip, candidate: LinkCandidate, decision: LinkDecision | null): LinkChip | null {
  const suggest = validScore(decision?.suggest);
  if (suggest === null) return chip;
  if (suggest < LINK_MIN_SCORE) return null;
  let best = -1;
  let bestScore = -1;
  candidate.urls.forEach((_item, index) => {
    const score = validScore(decision?.urls[index]);
    if (score !== null && score >= LINK_MIN_SCORE && score > bestScore) {
      best = index;
      bestScore = score;
    }
  });
  const pick = candidate.urls[best];
  if (!pick || pick.url === chip.url) return chip;
  return { ...chip, url: pick.url, label: chipLabel(pick.url) };
}

/** Why a step fell back to the plain chip, for a debug line. */
export type OnFallback = (reason: string) => void;

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function enrichOne(turn: string, chip: LinkChip, deps: EnrichDeps, signal: AbortSignal, onFallback?: OnFallback): Promise<LinkChip | null> {
  try {
    const hits = await deps.searchHistory(turn, chip.domain, signal).catch((error) => {
      onFallback?.(`history search failed: ${reasonOf(error)}`);
      return [];
    });
    const candidate = buildCandidate(chip, hits);
    const decision = await deps.decide(turn, candidate, signal).catch((error) => {
      onFallback?.(`Jev failed: ${reasonOf(error)}`);
      return null;
    });
    return applyDecision(chip, candidate, decision);
  } catch (error) {
    onFallback?.(`enrichment failed: ${reasonOf(error)}`);
    return chip;
  }
}

function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, onTimeout: T, onFallback?: OnFallback): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      onFallback?.(`timed out after ${ms} ms`);
      resolve(onTimeout);
    }, ms);
  });
  const guarded = work(controller.signal).catch((error) => {
    onFallback?.(`enrichment failed: ${reasonOf(error)}`);
    return onTimeout;
  });
  return Promise.race([guarded, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Enricher with a per-turn cache: the same turn text and chips never call vmem or Jev twice (in flight or done).
 * getDeps returns null when personalising is off or the Gateway key is missing; the chips then come back untouched.
 * onFallback hears why a step kept the plain chip (timeout, search or Jev error).
 * Output keeps the detector's order; chips Jev rejected are left out.
 */
export function createLinkEnricher(args: { getDeps: () => EnrichDeps | null; timeoutMs?: number; onFallback?: OnFallback }) {
  const cache = new Map<string, Promise<LinkChip[]>>();
  return function enrich(turn: string, chips: readonly LinkChip[]): Promise<LinkChip[]> {
    const plain = [...chips];
    if (plain.length === 0) return Promise.resolve(plain);
    const deps = args.getDeps();
    if (!deps) return Promise.resolve(plain);
    const key = `${turn}\n${plain.map((chip) => chip.id).join(",")}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const run = withTimeout(
      async (signal) => {
        const results = await Promise.all(plain.map((chip) => enrichOne(turn, chip, deps, signal, args.onFallback)));
        return results.filter((chip): chip is LinkChip => chip !== null);
      },
      args.timeoutMs ?? ENRICH_TIMEOUT_MS,
      plain,
      args.onFallback,
    );
    cache.set(key, run);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
    return run;
  };
}
