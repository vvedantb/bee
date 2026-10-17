import { VMemory } from "@vmem/sdk";
import { safeExternalUrl } from "./url-safety";
import { MAX_HISTORY_CANDIDATES, sameSite, type HistoryHit } from "./link-rank";

// Browsing history and bookmarks from vmem, for one site. Thin on purpose: the SDK does the HTTP, this keeps the right memories.

const SEARCH_LIMIT = 20;
const MAX_QUERY = 300;
const HISTORY_SOURCE = /history|bookmark/i;
const URL_IN_TEXT = /https?:\/\/[^\s<>"')\]]+/gi;
const TRAILING = /[.,;:!?]+$/;

/** The part of the SDK Bee uses. Newer SDKs have search(); 0.1.3 has searchMemories() only. Tests inject a fake. */
export type VmemSearchClient = {
  search?: (query: string, options: { limit: number; judge: "off" }) => Promise<unknown>;
  searchMemories?: (input: { query: string; limit: number }) => Promise<unknown>;
};

export function createVmemClient(args: { apiKey: string; baseUrl: string }): VmemSearchClient {
  return new VMemory({ apiKey: args.apiKey, baseUrl: args.baseUrl }) as unknown as VmemSearchClient;
}

function memoriesOf(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  const memories = (result as { memories?: unknown } | null)?.memories;
  return Array.isArray(memories) ? memories : [];
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** The memory's own url field when it has one (newer API), else http(s) URLs found in the title and content. */
function urlsOf(memory: Record<string, unknown>): string[] {
  const own = text(memory.url);
  if (own) return [own];
  return [text(memory.title), text(memory.content)].flatMap((part) => (part.match(URL_IN_TEXT) ?? []).map((url) => url.replace(TRAILING, "")));
}

/** Keep history and bookmark memories with a safe URL on the domain. Memories without a parseable URL are skipped. */
export function parseHistoryHits(result: unknown, domain: string): HistoryHit[] {
  const hits: HistoryHit[] = [];
  const seen = new Set<string>();
  for (const item of memoriesOf(result)) {
    if (hits.length >= MAX_HISTORY_CANDIDATES) break;
    if (typeof item !== "object" || item === null) continue;
    const memory = item as Record<string, unknown>;
    const source = text(memory.source);
    if (!HISTORY_SOURCE.test(source)) continue;
    for (const raw of urlsOf(memory)) {
      const url = safeExternalUrl(raw);
      if (!url || !sameSite(url, domain) || seen.has(url)) continue;
      seen.add(url);
      hits.push({ url, title: text(memory.title), source });
      break;
    }
  }
  return hits;
}

/**
 * Search without a source filter (an exact match is brittle) and filter client-side.
 * judge "off": Jev ranks the candidates, so vmem's own judge would only add latency.
 */
export function createVmemHistory(client: VmemSearchClient): (query: string, domain: string) => Promise<HistoryHit[]> {
  return async (query, domain) => {
    const text = `${domain} ${query}`.slice(0, MAX_QUERY);
    const result = client.search
      ? await client.search(text, { limit: SEARCH_LIMIT, judge: "off" })
      : await client.searchMemories?.({ query: text, limit: SEARCH_LIMIT });
    return parseHistoryHits(result, domain);
  };
}
