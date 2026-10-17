import { isStepCount, streamText, type LanguageModel, type ToolSet } from "ai";
import { withTimeout } from "./abort";
import { gatewayTier } from "./gateway";
import type { Snippet } from "./notes";
import { MAX_TIPS, tipCap } from "./steering";
import { lunaTools, sourcesFromGenerateResult, type BeeSource } from "./tools";

const TRANSCRIPT_WINDOW = 8;
const LUNA_TIMEOUT_MS = 45_000;
const MAX_STEPS = 8;
const SCHEMA_ERROR = /json schema|propertyNames|input_?schema|tools?\b.*\bschema|functionality.*not supported|not supported.*schema/i;

export const LUNA_SYSTEM = [
  "You are Bee, a quiet meeting copilot shown in a small overlay.",
  "Give the user at most 2 short tips.",
  "Each tip is one line, starts with \"- \", and is under 20 words.",
  "Reply in plain text only. No markdown: no bold, italic, headings or backticks, and no lists other than the \"- \" tip prefix.",
  "Do not write links or markdown citations. Bee shows the sources separately.",
  "If the latest transcript lines ask a direct question (a fact, a definition, a quick sum), the first tip answers it.",
  "Answer from the notes when they cover it and cite them by id, for example [n1].",
  "If the notes do not cover it and the fact is public, may have changed, or is current events (office holders, news, scores, prices, releases), use the web_search tool.",
  "After a search, you may end the tip with the site domain in plain text, or [web]. Do not add links.",
  "Do not search for stable general knowledge or arithmetic, for example 15% of 18000. Answer those directly.",
  "If the notes do not cover a question about the user's own notes or files, use list_dir, search_files and read_file, then answer from what you read.",
  "Prefer the notes above ([n1]…) first. Do not use web_search for private facts about the user's own work or files.",
  "Use append_note only when the user clearly asks to add or save a note.",
  "Otherwise, suggest what to say or do next, using the notes when they help and citing them.",
  "Never invent facts, figures or dates about the user's own work that are not in the transcript or notes.",
  "If nothing useful can be said, reply with exactly NONE.",
].join("\n");

/** Added to the system prompt only when tips are already on screen (the user kept talking). */
export const LUNA_STEERING_SYSTEM = [
  "If tips are already shown, add tips for new lines.",
  "Return the full set: copy each shown tip that still stands word for word, then add the new tips.",
  "Replace a shown tip only if the new line corrects it.",
  "If the new lines need no tip, copy the shown tips.",
].join("\n");

// The tip cap is 2 for a fresh turn and 3 while earlier tips are kept (steering.ts tipCap).
function lunaSystem(maxTips: number): string {
  return maxTips === MAX_TIPS ? LUNA_SYSTEM : LUNA_SYSTEM.replace("at most 2 short tips", `at most ${maxTips} short tips`);
}

/** Added to the system prompt only when the user has connected MCP tools. */
export const LUNA_MCP_SYSTEM = [
  "The user has connected MCP servers, for example vmem or Eva. Their tools are named server__tool, for example vmem__search.",
  "Call them when the transcript needs what those servers hold. Use them before guessing about the user's own data.",
  "For questions about the user's product or data (counts, users, tables, docs, tasks), call the connected tools instead of guessing.",
  "For \"how many X\" or table counts, use list_tables, count_table, query_table, run_query or postgres_query, for example eva__list_tables then eva__count_table. Other tools include eva__list_repos.",
  "Answer in the tip with the number or fact the tool returned.",
  "If an MCP tool returns an error, say so briefly or skip it. Never invent a result.",
].join("\n");

export function noteCitation(index: number): string {
  return `n${index + 1}`;
}

export type LunaPrompt = { system: string; prompt: string };

export function buildLunaPrompt(args: { transcript: string[]; notes: Snippet[]; hasMcpTools?: boolean; shown?: string[] }): LunaPrompt {
  const lines = args.transcript.slice(-TRANSCRIPT_WINDOW).map((line) => `- ${line.trim()}`);
  const shown = (args.shown ?? []).map((tip) => tip.replace(/\s+/g, " ").trim()).filter((tip) => tip.length > 0);
  const notes = args.notes.map((note, index) => `[${noteCitation(index)}] ${note.title}\n${note.text}`);
  const prompt = [
    "Recent transcript (oldest first):",
    lines.join("\n"),
    "",
    ...(shown.length > 0
      ? ["Already shown to the user (keep; do not repeat; refine only if the new line changes the answer):", ...shown.map((tip) => `- ${tip}`), ""]
      : []),
    "Relevant notes:",
    notes.length > 0 ? notes.join("\n\n") : "(none)",
    "",
    "Tips:",
  ].join("\n");
  const system = [
    shown.length > 0 ? lunaSystem(tipCap(shown.length)) : LUNA_SYSTEM,
    ...(args.hasMcpTools ? [LUNA_MCP_SYSTEM] : []),
    ...(shown.length > 0 ? [LUNA_STEERING_SYSTEM] : []),
  ];
  return { system: system.join("\n"), prompt };
}

/** Removes markdown the model may still emit, keeping plain text and note cites such as [n1]. */
function stripMarkdown(line: string): string {
  return line
    .replace(/^#{1,6}\s*/, "")
    .replace(/^(?:[-*•]|\d+[.)])\s+/, "")
    .replace(/\(\s*\[([^\]]*)\]\(\s*[^)\s]*\s*\)\s*\)/g, "$1")
    .replace(/\[([^\]]*)\]\(\s*[^)\s]*\s*\)/g, "$1")
    .replace(/\(\s*https?:\/\/[^)\s]*\)/g, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(?<![\w*])\*(?=\S)([^*]+?)\*(?![\w*])/g, "$1")
    .replace(/(?<!\w)_(?=\S)([^_]+?)_(?!\w)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function parseLunaTips(text: string, maxTips = MAX_TIPS): string[] {
  if (text.trim().toUpperCase() === "NONE") return [];
  return text
    .split("\n")
    .map((line) => stripMarkdown(line.trim()))
    .filter((line) => line.length > 0 && line.toUpperCase() !== "NONE")
    .slice(0, maxTips);
}

/** A streamed line shows once it has this many words, so a lone "NONE" or "- " never flashes. */
const MIN_LIVE_WORDS = 4;

/**
 * Tips so far from streamed text: every finished line, plus the line in progress once it has a few whole words.
 * Only a hint for the overlay. parseLunaTips on the full text stays the final authority (NONE, 2-tip cap).
 */
export function streamingTips(text: string, maxTips = MAX_TIPS): string[] {
  const parts = text.split("\n");
  const open = (parts.pop() ?? "").replace(/\S*$/, "");
  const tips = parts.map((line) => stripMarkdown(line.trim())).filter((line) => line.length > 0 && line.toUpperCase() !== "NONE");
  const live = stripMarkdown(open.trim());
  if (live.split(/\s+/).length >= MIN_LIVE_WORDS && live.toUpperCase() !== "NONE") tips.push(live);
  return tips.slice(0, maxTips);
}

export type LunaResult = {
  tips: string[];
  sources: BeeSource[];
  error: string | null;
  /** Short muted note when connected tools were skipped. */
  skipped: string | null;
  /** Milliseconds to the first text of the final step (null: none came), and for the whole call, retries included. Numbers only. */
  firstTokenMs: number | null;
  totalMs: number;
};

/** Tools the error names; else tools whose schema has a key the error names (providers name the keyword, not the tool); else every extra tool. */
function toolsToDrop(message: string, extra: ToolSet): string[] {
  const names = Object.keys(extra);
  const named = names.filter((name) => message.includes(name));
  if (named.length > 0) return named;
  const words = [...new Set(message.match(/\$?[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? [])];
  const usesKeyword = names.filter((name) => {
    const schema = JSON.stringify((extra[name] as { inputSchema?: { jsonSchema?: unknown } }).inputSchema?.jsonSchema ?? {});
    return words.some((word) => schema.includes(`"${word}":`));
  });
  return usesKeyword.length > 0 ? usesKeyword : names;
}

export async function guideWithLuna(args: {
  model: LanguageModel;
  transcript: string[];
  notes: Snippet[];
  /** Tips already on screen (complete lines). Luna adds tips for the new lines and returns the full set, up to 3. */
  shown?: string[];
  timeoutMs?: number;
  /** Notes folder and extra approved folders for the file tools. Without notesDir, Luna gets no file tools. */
  notesDir?: string;
  extraRoots?: readonly string[];
  /** MCP tools from loadMcpTools. The caller closes the connections after the run. */
  extraTools?: ToolSet;
  /** Called with each tool Luna calls, so the overlay can show what it is doing. */
  onActivity?: (toolName: string) => void;
  /** Called with the tips so far as lines stream in. Only when they change. */
  onPartial?: (tips: string[]) => void;
  /** Cancels the call (a superseded run). Tool calls already running are left to finish. */
  signal?: AbortSignal;
}): Promise<LunaResult> {
  const startedAt = performance.now();
  const maxTips = tipCap(args.shown?.length ?? 0);
  let firstTokenMs: number | null = null;
  let extra: ToolSet = { ...args.extraTools };
  const dropped: string[] = [];
  const skipped = () => {
    if (dropped.length === 0) return null;
    if (dropped.length === 1) return `Skipped connected tool: ${dropped[0]}.`;
    if (dropped.length <= 3) return `Skipped connected tools: ${dropped.join(", ")}.`;
    return `Skipped ${dropped.length} connected tools.`;
  };
  const timings = () => {
    const totalMs = performance.now() - startedAt;
    console.debug(`perf luna firstToken=${firstTokenMs === null ? "none" : `${Math.round(firstTokenMs)}ms`} total=${Math.round(totalMs)}ms`);
    return { firstTokenMs, totalMs };
  };
  const reported = new Set<string>();
  const report = (id: string, name: string) => {
    if (reported.has(id)) return;
    reported.add(id);
    args.onActivity?.(name);
  };
  const run = async () => {
    const { system, prompt } = buildLunaPrompt({ ...args, hasMcpTools: Object.keys(extra).length > 0 });
    const abortSignal = withTimeout(args.signal, args.timeoutMs ?? LUNA_TIMEOUT_MS);
    const result = streamText({
      model: args.model,
      system,
      prompt,
      tools: lunaTools({ notesDir: args.notesDir, extraRoots: args.extraRoots, extra }),
      stopWhen: isStepCount(MAX_STEPS),
      // Local tools report as they start. Provider tools (web_search) report when their step finishes. Each call reports once.
      onToolExecutionStart: ({ toolCall }) => report(toolCall.toolCallId, toolCall.toolName),
      onStepFinish: (step) => {
        for (const call of step.toolCalls) report(call.toolCallId, call.toolName);
      },
      // Errors arrive as stream parts and are thrown below, so the schema retry sees them.
      onError: () => undefined,
      maxOutputTokens: 800,
      maxRetries: 1,
      abortSignal,
      // User-facing: not flex (see gateway.ts).
      providerOptions: { ...gatewayTier("default"), openai: { reasoningEffort: "low" } },
    });
    // Only the last step's text is the answer, so each step starts a fresh buffer.
    let text = "";
    let sent = "";
    firstTokenMs = null;
    for await (const part of result.stream) {
      if (part.type === "start-step") {
        text = "";
      } else if (part.type === "text-delta") {
        text += part.text;
        if (firstTokenMs === null && part.text.trim()) firstTokenMs = performance.now() - startedAt;
        const tips = streamingTips(text, maxTips);
        const key = JSON.stringify(tips);
        if (tips.length > 0 && key !== sent) {
          sent = key;
          args.onPartial?.(tips);
        }
      } else if (part.type === "error") {
        throw part.error;
      } else if (part.type === "abort") {
        throw abortSignal.reason instanceof Error ? abortSignal.reason : new Error("aborted");
      }
    }
    // The stream can also end quietly when the signal fires.
    if (abortSignal.aborted) throw abortSignal.reason instanceof Error ? abortSignal.reason : new Error("aborted");
    return { text, sources: await result.sources, toolResults: await result.toolResults };
  };
  // First try with every tool. A tools-schema error drops the named tools (else all), then all extras, then stops.
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await run();
      return { tips: parseLunaTips(result.text, maxTips), sources: sourcesFromGenerateResult(result), error: null, skipped: skipped(), ...timings() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (args.signal?.aborted || !SCHEMA_ERROR.test(message) || attempt >= 2 || Object.keys(extra).length === 0) {
        return { tips: [], sources: [], error: `Luna guidance failed: ${message}`, skipped: skipped(), ...timings() };
      }
      const drop = attempt === 0 ? toolsToDrop(message, extra) : Object.keys(extra);
      console.warn(`Bee: dropped MCP tools after a schema error: ${drop.join(", ")}`);
      dropped.push(...drop);
      extra = Object.fromEntries(Object.entries(extra).filter(([name]) => !drop.includes(name)));
    }
  }
}
