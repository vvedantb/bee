import { anthropic } from "@ai-sdk/anthropic";
import type { ToolSet } from "ai";
import { z } from "zod";
import { fsTools } from "./fs-tools";
import type { SearchLocation } from "./web-search";
import { MAX_URL_LENGTH, stripTrackingParams } from "./url-safety";

const MAX_SOURCES = 5;
const MAX_TITLE_LENGTH = 300;
const MAX_WEB_SEARCHES = 3;

export type BeeSource = { title: string; url: string };

/** Tools Luna may call. Add new tools here; guideWithLuna passes the whole set. */
/** `web: false` leaves out web_search (a turn that needs no search, or a provider that rejects it, see guideWithLuna). */
/** `location` is the user's approximate place, so search results are local. Search is never limited to a domain list. */
export function lunaTools(
  options: {
    notesDir?: string;
    extraRoots?: readonly string[];
    extra?: ToolSet;
    web?: boolean;
    location?: SearchLocation;
  } = {},
): ToolSet {
  // Anthropic runs this search itself, so the Gateway must route the call to Anthropic (gateway.ts guideProviderOptions).
  // The basic version: 20260209/20260318 add dynamic filtering, which searches from a code execution sandbox, and Haiku
  // via the Gateway only called code_execution there and never searched.
  const search = anthropic.tools.webSearch_20250305({
    maxUses: MAX_WEB_SEARCHES,
    ...(options.location ? { userLocation: options.location } : {}),
  });
  const web: ToolSet = options.web === false ? {} : { web_search: search };
  const local = options.notesDir ? { ...web, ...fsTools({ notesDir: options.notesDir, extraRoots: options.extraRoots }) } : web;
  // MCP tools (core/mcp.ts) are namespaced; spreading them first also means they can never replace a built-in.
  return { ...options.extra, ...local };
}

// Search results as providers return them. Document sources have no url, so they never parse.
const rawSource = z.object({ url: z.string(), title: z.string().nullish() });
type RawSource = z.infer<typeof rawSource>;
// Anthropic's web search returns an array of `web_search_result` items; other search tools return `{ sources }`.
const toolResultShape = z.object({
  output: z.union([z.array(z.unknown()), z.object({ sources: z.array(z.unknown()) }).transform((output) => output.sources)]),
});

function rawSources(list: readonly unknown[]): RawSource[] {
  return list.flatMap((item) => {
    const parsed = rawSource.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function collectRaw(result: { sources?: readonly unknown[]; toolResults?: readonly unknown[] }): RawSource[] {
  const direct = rawSources(result.sources ?? []);
  if (direct.length > 0) return direct;
  return (result.toolResults ?? []).flatMap((toolResult) => {
    const parsed = toolResultShape.safeParse(toolResult);
    return parsed.success ? rawSources(parsed.data.output) : [];
  });
}

// Drops sentence punctuation glued to a url. A trailing ")" goes only when unbalanced, so Today_(BBC_Radio_4) keeps it.
function trimUrl(url: string): string {
  let trimmed = url.trim().replace(/[.,]+$/, "");
  while (trimmed.endsWith(")") && trimmed.split(")").length > trimmed.split("(").length) {
    trimmed = trimmed.slice(0, -1).replace(/[.,]+$/, "");
  }
  return trimmed;
}

function toSource(raw: RawSource): BeeSource | null {
  let parsed: URL;
  try {
    parsed = new URL(trimUrl(raw.url));
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  stripTrackingParams(parsed);
  if (parsed.href.length > MAX_URL_LENGTH) return null;
  const title = raw.title?.trim() ?? "";
  return {
    title: (title || parsed.hostname).slice(0, MAX_TITLE_LENGTH),
    url: parsed.href,
  };
}

export function sourcesFromGenerateResult(result: {
  sources?: readonly unknown[];
  toolResults?: readonly unknown[];
}): BeeSource[] {
  const seen = new Set<string>();
  const sources: BeeSource[] = [];
  for (const raw of collectRaw(result)) {
    const source = toSource(raw);
    if (!source || seen.has(source.url)) continue;
    seen.add(source.url);
    sources.push(source);
    if (sources.length === MAX_SOURCES) break;
  }
  return sources;
}
