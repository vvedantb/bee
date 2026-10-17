import { openai } from "@ai-sdk/openai";
import type { ToolSet } from "ai";
import { fsTools } from "./fs-tools";

const MAX_SOURCES = 5;
const MAX_TITLE_LENGTH = 300;
const MAX_URL_LENGTH = 2000;

export type BeeSource = { title: string; url: string };

/** Tools Luna may call. Add new tools here; guideWithLuna passes the whole set. */
export function lunaTools(options: { notesDir?: string; extraRoots?: readonly string[]; extra?: ToolSet } = {}) {
  const web = { web_search: openai.tools.webSearch({ searchContextSize: "low" }) };
  const local = options.notesDir ? { ...web, ...fsTools({ notesDir: options.notesDir, extraRoots: options.extraRoots }) } : web;
  // MCP tools (core/mcp.ts) are namespaced; spreading them first also means they can never replace a built-in.
  return { ...options.extra, ...local };
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

const TRACKING_PARAMS = new Set(["fbclid", "gclid", "ref", "ref_src"]);

function toSource(raw: RawSource): BeeSource | null {
  if (typeof raw.url !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(raw.url.trim().replace(/[.,)]+$/, ""));
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  for (const [key, value] of [...parsed.searchParams.entries()]) {
    const name = key.toLowerCase();
    if (name.startsWith("utm_") || TRACKING_PARAMS.has(name) || (name === "source" && value.toLowerCase().startsWith("post_page"))) {
      parsed.searchParams.delete(key);
    }
  }
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
