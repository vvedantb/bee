import { connectMcp, type McpConnection, type McpServerConfig } from "./mcp";
import { safeExternalUrl } from "./url-safety";
import { MAX_HISTORY_CANDIDATES, sameSite, type HistoryHit } from "./link-rank";

// Browsing history and bookmarks from the user's vmem MCP connector, for one site. The search goes through Bee's own MCP client.
// Tool output is free-form text, so parsing is tolerant: a missing field skips that item, never throws.

const SEARCH_LIMIT = 20;
const MAX_QUERY = 300;
// This path lives inside the 1.5 s enrich budget (ENRICH_TIMEOUT_MS), so it cannot use the 10 s and 15 s Luna defaults.
export const VMEM_CONNECT_TIMEOUT_MS = 800;
export const VMEM_CALL_TIMEOUT_MS = 800;
const HISTORY_SOURCE = /history|bookmark/i;
const DEFAULT_SOURCE = "browsing history";
const URL_IN_TEXT = /https?:\/\/[^\s<>"')\]]+/gi;
const TRAILING = /[.,;:!?]+$/;
const LIST_KEYS = ["memories", "results", "data"];
// A hit may be the memory itself or a wrapper such as { memory, score }.
const WRAPPER_KEYS = ["memory", "item", "result", "document"];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** JSON.parse of the whole string, else of the first {...} or [...] span in it. undefined when there is none. */
export function parseJsonLoose(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to the embedded span.
  }
  // Whichever bracket opens first wins, so an array of objects is not read as its first object.
  const spans = ([["{", "}"], ["[", "]"]] as const).map(([open, close]) => ({ start: trimmed.indexOf(open), end: trimmed.lastIndexOf(close) }));
  for (const { start, end } of spans.filter((span) => span.start !== -1 && span.end > span.start).sort((a, b) => a.start - b.start)) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // Try the other bracket.
    }
  }
  return undefined;
}

/** The items of a search result: a top-level array, or one under memories, results or data (which may nest once more). */
function itemsOf(result: unknown, depth = 0): unknown[] {
  if (Array.isArray(result)) return result;
  if (!isRecord(result) || depth > 1) return [];
  for (const key of LIST_KEYS) {
    const items = itemsOf(result[key], depth + 1);
    if (items.length > 0) return items;
  }
  return [];
}

/** The item itself, plus a wrapped memory when there is one. Fields are read from both. */
function layersOf(item: Record<string, unknown>): Array<Record<string, unknown>> {
  const inner = WRAPPER_KEYS.map((key) => item[key]).find(isRecord);
  return inner ? [inner, item] : [item];
}

/** An explicit url, href or link when a string, else the http(s) URLs found in the title, content and text. */
function urlsOf(layers: ReadonlyArray<Record<string, unknown>>): string[] {
  const own = layers.flatMap((layer) => [layer.url, layer.href, layer.link]).filter((value): value is string => typeof value === "string" && value !== "");
  if (own.length > 0) return own;
  return layers.flatMap((layer) =>
    [layer.title, layer.content, layer.text].flatMap((part) => (text(part).match(URL_IN_TEXT) ?? []).map((url) => url.replace(TRAILING, ""))),
  );
}

/**
 * Keep history and bookmark memories with a safe URL on the domain. `result` is the tool's output: a string (text or JSON) or parsed JSON.
 * A memory with a source that is not history or bookmarks is skipped. One without a source is kept when its URL is on the domain.
 * Never throws; anything unreadable gives [].
 */
export function parseHistoryHits(result: unknown, domain: string): HistoryHit[] {
  const parsed = typeof result === "string" ? parseJsonLoose(result) : result;
  const hits: HistoryHit[] = [];
  const seen = new Set<string>();
  for (const item of itemsOf(parsed)) {
    if (hits.length >= MAX_HISTORY_CANDIDATES) break;
    if (!isRecord(item)) continue;
    const layers = layersOf(item);
    const source = layers.map((layer) => text(layer.source)).find((value) => value !== "") ?? "";
    if (source && !HISTORY_SOURCE.test(source)) continue;
    for (const raw of urlsOf(layers)) {
      const url = safeExternalUrl(raw);
      if (!url || !sameSite(url, domain) || seen.has(url)) continue;
      seen.add(url);
      hits.push({ url, title: layers.map((layer) => text(layer.title)).find((value) => value !== "") ?? "", source });
      break;
    }
  }
  return hits;
}

/**
 * History search over an injected `callSearch(query, domain)` that returns the tool's raw output (the MCP version is below).
 * Failures and unreadable output give [] and report why through onFallback, so Jev still runs on the plain domain.
 */
export function createVmemHistory(
  callSearch: (query: string, domain: string) => Promise<unknown>,
  onFallback?: (reason: string) => void,
): (query: string, domain: string) => Promise<HistoryHit[]> {
  return async (query, domain) => {
    let result: unknown;
    try {
      result = await callSearch(`${domain} ${query}`.slice(0, MAX_QUERY), domain);
    } catch (error) {
      onFallback?.(`vmem search failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
    const hits = parseHistoryHits(result, domain);
    if (hits.length === 0 && typeof result === "string" && result.trim() !== "" && parseJsonLoose(result) === undefined) {
      onFallback?.("vmem search output could not be parsed");
    }
    return hits;
  };
}

type McpTool = McpConnection["tools"][number];

/** `memory_search`, else `search`, else a tool with both "memory" and "search" in its name. */
export function pickSearchTool(tools: readonly McpTool[]): McpTool | undefined {
  const named = (test: (name: string) => boolean) => tools.find((tool) => test(tool.name.toLowerCase()));
  return named((name) => name === "memory_search") ?? named((name) => name === "search") ?? named((name) => name.includes("memory") && name.includes("search"));
}

/** query and limit, plus `source` only when the tool has that property. An enum gets a listed history value, or no source at all. */
export function searchArguments(tool: McpTool, query: string): Record<string, unknown> {
  const properties = isRecord(tool.inputSchema?.properties) ? tool.inputSchema.properties : undefined;
  const args: Record<string, unknown> = { query };
  if (!properties || "limit" in properties) args.limit = SEARCH_LIMIT;
  const source = properties?.source;
  if (!isRecord(source)) return args;
  if (Array.isArray(source.enum)) {
    const listed = source.enum.filter((value): value is string => typeof value === "string");
    const match = listed.find((value) => /history/i.test(value)) ?? listed.find((value) => /bookmark/i.test(value));
    if (match) args.source = match;
  } else {
    args.source = DEFAULT_SOURCE;
  }
  return args;
}

/**
 * Searches the connector with short timeouts. Throws on connect, list or call failure (createVmemHistory turns that into []).
 * The connection closes in the background so the enrich budget is not spent waiting for it.
 */
export function createMcpSearch(config: McpServerConfig): (query: string) => Promise<string> {
  return async (query) => {
    const connection = await connectMcp(config, VMEM_CONNECT_TIMEOUT_MS);
    try {
      const tool = pickSearchTool(connection.tools);
      if (!tool) throw new Error("no memory search tool");
      return await connection.call(tool.name, searchArguments(tool, query), VMEM_CALL_TIMEOUT_MS);
    } finally {
      void connection.close();
    }
  };
}
