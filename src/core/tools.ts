import { openai } from "@ai-sdk/openai";

const MAX_SOURCES = 5;
const MAX_TITLE_LENGTH = 300;
const MAX_URL_LENGTH = 2000;

export type BeeSource = { title: string; url: string };

/** Tools Luna may call. Add new tools here; guideWithLuna passes the whole set. */
export function lunaTools() {
  return {
    web_search: openai.tools.webSearch({ searchContextSize: "low" }),
  };
}

type RawSource = { url?: unknown; title?: unknown };

function collectRaw(result: { sources?: readonly unknown[]; toolResults?: readonly unknown[] }): RawSource[] {
  const direct = (result.sources ?? []).filter(
    (source): source is RawSource => typeof source === "object" && source !== null && (source as { sourceType?: unknown }).sourceType !== "document",
  );
  if (direct.length > 0) return direct;
  const fromTools: RawSource[] = [];
  for (const toolResult of result.toolResults ?? []) {
    const output = (toolResult as { output?: { sources?: unknown } } | null)?.output;
    if (Array.isArray(output?.sources)) fromTools.push(...output.sources.filter((item): item is RawSource => typeof item === "object" && item !== null));
  }
  return fromTools;
}

function toSource(raw: RawSource): BeeSource | null {
  if (typeof raw.url !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(raw.url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.href.length > MAX_URL_LENGTH) return null;
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
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
