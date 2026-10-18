import type { McpPool, McpServerConfig } from "./mcp";
import { parseJsonLoose } from "./vmem-history";

// Related notes for the meeting from the user's connected MCP servers (vmem, Eva and so on), through the shared pool and its
// cached tool lists. Bounded and fail open: a slow or broken server costs nothing but its own notes.

export const MAX_SERVERS = 3;
export const CALL_TIMEOUT_MS = 4000;
export const CONNECT_TIMEOUT_MS = 4000;
/** One search for every server together. */
export const TOTAL_TIMEOUT_MS = 8000;
const RESULT_CHARS = 6000;
const SNIPPET_MAX = 280;
const SNIPPETS_PER_SERVER = 2;
const LIMIT = 5;

type Tool = { name: string; description: string; inputSchema: Record<string, unknown> };

// A tool that writes or changes data is never called, whatever its name says about search.
const WRITES = /(^|[_-])(add|create|delete|remove|update|write|save|set|put|post|insert|send|run|exec|execute|import|forget)([_-]|$)/i;
const SEARCHES = /search|query|recall|find|lookup|retrieve/i;
const QUERY_FIELDS = ["query", "q", "text", "search", "search_query", "question", "keywords", "prompt"];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The tool to ask: memory_search, then search, then another read-only search-like tool, preferring one that mentions memory. */
export function pickMeetingSearchTool(tools: readonly Tool[]): Tool | undefined {
  const candidates = tools.filter((tool) => !WRITES.test(tool.name) && (SEARCHES.test(tool.name) || /search|memory/i.test(tool.description)));
  const byName = (name: string) => candidates.find((tool) => tool.name.toLowerCase() === name);
  return (
    byName("memory_search") ??
    byName("search") ??
    candidates.find((tool) => /memory/i.test(tool.name) && /search/i.test(tool.name)) ??
    candidates.find((tool) => SEARCHES.test(tool.name)) ??
    candidates.find((tool) => /memory/i.test(tool.description))
  );
}

/** Arguments for a search tool: the query in its text field, and a small limit when it has one. Null when no text field is found. */
export function searchToolArguments(tool: Pick<Tool, "inputSchema">, query: string): Record<string, unknown> | null {
  const properties = isRecord(tool.inputSchema.properties) ? tool.inputSchema.properties : {};
  const field = QUERY_FIELDS.find((name) => isRecord(properties[name]) && (properties[name] as { type?: unknown }).type === "string");
  if (!field) return null;
  const args: Record<string, unknown> = { [field]: query };
  for (const name of ["limit", "top_k", "k", "max_results"]) if (isRecord(properties[name])) args[name] = LIMIT;
  return args;
}

const TEXT_KEYS = ["content", "text", "summary", "memory", "title", "snippet"];

function itemText(item: unknown): string {
  if (typeof item === "string") return item;
  if (!isRecord(item)) return "";
  const inner = ["memory", "item", "result", "document"].map((key) => item[key]).find(isRecord);
  for (const layer of inner ? [inner, item] : [item]) {
    const parts = TEXT_KEYS.flatMap((key) => (typeof layer[key] === "string" ? [layer[key] as string] : []));
    if (parts.length > 0) return parts.join(" – ");
  }
  return "";
}

/** Up to `count` short snippets from a tool's output: JSON lists (memories, results, data) or plain text. Errors give []. */
export function snippetsFromOutput(output: string, count = SNIPPETS_PER_SERVER): string[] {
  const trimmed = output.trim();
  if (!trimmed || trimmed === "(no output)" || /^error:/i.test(trimmed)) return [];
  const parsed = parseJsonLoose(trimmed);
  let items: unknown[] | null = null;
  if (Array.isArray(parsed)) items = parsed;
  else if (isRecord(parsed)) {
    for (const key of ["memories", "results", "data", "items"]) {
      const list = parsed[key];
      if (Array.isArray(list)) {
        items = list;
        break;
      }
    }
  }
  const texts = items ? items.map(itemText) : [trimmed];
  return texts
    .map((value) => value.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim())
    .filter((value) => value.length > 0)
    .slice(0, count)
    .map((value) => (value.length > SNIPPET_MAX ? `${value.slice(0, SNIPPET_MAX - 1).trimEnd()}…` : value));
}

/** One server: pick its search tool from the cached list, call it once, return short snippets. [] on any problem. */
async function searchServer(config: McpServerConfig, query: string, pool: McpPool): Promise<string[]> {
  try {
    const { tools } = await pool.list(config, CONNECT_TIMEOUT_MS);
    const usable = tools.filter((tool) => !config.disabledTools?.includes(tool.name));
    const tool = pickMeetingSearchTool(usable);
    const args = tool ? searchToolArguments(tool, query) : null;
    if (!tool || !args) return [];
    const connection = await pool.ensure(config, CONNECT_TIMEOUT_MS);
    return snippetsFromOutput(await connection.call(tool.name, args, CALL_TIMEOUT_MS, RESULT_CHARS));
  } catch {
    pool.drop(config);
    return [];
  }
}

/**
 * Notes for the meeting from up to MAX_SERVERS connected servers, in parallel, inside TOTAL_TIMEOUT_MS. The query and the
 * results are never logged: only the counts.
 */
export async function searchMcpNotes(args: { configs: readonly McpServerConfig[]; pool: McpPool; query: string; totalTimeoutMs?: number }): Promise<string[]> {
  const configs = args.configs.slice(0, MAX_SERVERS);
  if (configs.length === 0 || !args.query.trim()) return [];
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  const results = await Promise.race([
    Promise.all(configs.map((config) => searchServer(config, args.query, args.pool))),
    new Promise<string[][]>((resolve) => {
      timer = setTimeout(() => resolve([]), args.totalTimeoutMs ?? TOTAL_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
  const notes = results.flat();
  console.debug(`perf meeting-search servers=${configs.length} notes=${notes.length} ms=${Math.round(performance.now() - started)}`);
  return notes;
}
