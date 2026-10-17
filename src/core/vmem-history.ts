import { connectMcp, type McpConnection, type McpServerConfig } from "./mcp";
import { safeExternalUrl } from "./url-safety";
import { MAX_HISTORY_CANDIDATES, sameSite, type HistoryHit } from "./link-rank";

// Browsing history and bookmarks from the user's vmem MCP connector, for one site. The search goes through Bee's own MCP client.
// Tool output is free-form text, so parsing is tolerant: a missing field skips that item, never throws.

// 8 results is about 7 KB of JSON; 20 was 17.6 KB and passed the old 8,000 character cap, which cut the JSON.
const SEARCH_LIMIT = 8;
// Room for a full result list. Cut-off JSON cannot be parsed, so this internal call does not use Luna's 8,000 character cap.
const MAX_RESULT_CHARS = 100_000;
const MAX_QUERY = 300;
// Searches run on a connection that is already open, inside the 2.5 s enrich budget (ENRICH_TIMEOUT_MS), so a call gets about 1.5 s (live calls took 450–790 ms).
// Connecting happens in the background (app start, sign-in), outside that budget: a slow connect only costs the chip that waited for it.
export const VMEM_CONNECT_TIMEOUT_MS = 5000;
export const VMEM_CALL_TIMEOUT_MS = 1500;
const HISTORY_SOURCE = /history|bookmark/i;
// vmem stores history as source "browsing-history" and matches the filter exactly ("browsing history" returns nothing).
const HISTORY_SOURCE_VALUE = "browsing-history";
// Assumed value for bookmarks when the tool's source is free text: an unknown value only returns nothing.
const BOOKMARK_SOURCE_VALUE = "bookmark";
// A backslash ends a URL too: in raw JSON text (output cut off at the MCP result limit) "\\n" follows the URL, and must not become "/n…".
const URL_IN_TEXT = /https?:\/\/[^\s<>"')\]\\]+/gi;
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
    const unparsed = typeof result === "string" ? result.trim() !== "" && parseJsonLoose(result) === undefined : isRecord(result) && result.unparsed === true;
    if (hits.length === 0 && unparsed) {
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

/** The source filters to search, one call each: history and bookmarks. undefined means no filter (the tool has no source, or no listed match). */
export function searchSources(tool: McpTool): Array<string | undefined> {
  const source = isRecord(tool.inputSchema?.properties) ? tool.inputSchema.properties.source : undefined;
  if (!isRecord(source)) return [undefined];
  if (!Array.isArray(source.enum)) return [HISTORY_SOURCE_VALUE, BOOKMARK_SOURCE_VALUE];
  // An enum only gets values it lists.
  const listed = source.enum.filter((value): value is string => typeof value === "string");
  const matches = [/history/i, /bookmark/i].flatMap((pattern) => listed.find((value) => pattern.test(value)) ?? []);
  return matches.length > 0 ? matches : [undefined];
}

/** query and limit, plus `source` when given and the tool has that property. */
export function searchArguments(tool: McpTool, query: string, source?: string): Record<string, unknown> {
  const properties = isRecord(tool.inputSchema?.properties) ? tool.inputSchema.properties : undefined;
  const args: Record<string, unknown> = { query };
  if (!properties || "limit" in properties) args.limit = SEARCH_LIMIT;
  if (source !== undefined && properties && "source" in properties) args.source = source;
  return args;
}

/** One result list from several tool outputs. Text that is not JSON becomes a single item, so its URLs are still read, and sets `unparsed`. */
export function mergeSearchOutputs(outputs: readonly string[]): { results: unknown[]; unparsed?: true } {
  let unparsed = false;
  const results = outputs.flatMap((output) => {
    const parsed = parseJsonLoose(output);
    if (parsed !== undefined) return itemsOf(parsed);
    if (!output.trim()) return [];
    unparsed = true;
    return [{ content: output }];
  });
  return unparsed ? { results, unparsed } : { results };
}

export type VmemSearch = {
  /** History and bookmark results for a query, merged. Throws when the connector is missing, signed out or fails. */
  search: (query: string) => Promise<unknown>;
  /** Opens the connection now when the connector is enabled and signed in, closes it otherwise. Call at start and after Connectors changes. */
  refresh: () => void;
  /** Closes the connection. A later search or refresh opens a new one. */
  close: () => Promise<void>;
};

/**
 * Keeps one MCP connection to the vmem connector open, so a chip pays for the search call and not for connecting.
 * `getConfig` is read on each call, so Connectors changes apply. Fail open: callers treat a throw as no history.
 */
export function createVmemSearch(getConfig: () => McpServerConfig | undefined, connect: typeof connectMcp = connectMcp): VmemSearch {
  type Entry = { key: string; ready: Promise<McpConnection> };
  let current: Entry | undefined;

  const signedIn = (config: McpServerConfig): boolean => config.auth.type !== "none" || Boolean(config.oauthSignedIn);

  async function close(): Promise<void> {
    const entry = current;
    current = undefined;
    await entry?.ready.then((connection) => connection.close(), () => undefined);
  }

  function open(config: McpServerConfig): Promise<McpConnection> {
    const key = [config.id, config.url, config.auth.type, config.oauthSignedIn].join("|");
    if (current?.key === key) return current.ready;
    void close();
    const entry: Entry = { key, ready: connect(config, VMEM_CONNECT_TIMEOUT_MS) };
    current = entry;
    // A failed connect is not kept, so the next call tries again.
    entry.ready.catch(() => {
      if (current === entry) current = undefined;
    });
    return entry.ready;
  }

  return {
    refresh: () => {
      const config = getConfig();
      if (!config || !signedIn(config)) {
        void close();
        return;
      }
      open(config).catch((error: unknown) => console.warn("Bee: vmem connector error:", error instanceof Error ? error.message : String(error)));
    },
    close,
    search: async (query) => {
      const config = getConfig();
      if (!config) throw new Error("vmem is not connected");
      if (!signedIn(config)) throw new Error("vmem is not signed in");
      const connection = await open(config);
      const tool = pickSearchTool(connection.tools);
      if (!tool) throw new Error("no memory search tool");
      const settled = await Promise.allSettled(
        searchSources(tool).map((source) => connection.call(tool.name, searchArguments(tool, query, source), VMEM_CALL_TIMEOUT_MS, MAX_RESULT_CHARS)),
      );
      const outputs = settled.flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value] : []));
      if (outputs.length > 0) return mergeSearchOutputs(outputs);
      const reason = (settled[0] as PromiseRejectedResult).reason as unknown;
      // A slow call leaves the connection fine; any other failure may mean it dropped, so the next search reconnects.
      if (!(reason instanceof Error && /timed out/.test(reason.message))) void close();
      throw reason;
    },
  };
}
