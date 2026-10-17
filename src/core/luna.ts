import { generateText, isStepCount, type LanguageModel, type ToolSet } from "ai";
import { FLEX_PROVIDER_OPTIONS } from "./gateway";
import type { Snippet } from "./notes";
import { lunaTools, sourcesFromGenerateResult, type BeeSource } from "./tools";

const TRANSCRIPT_WINDOW = 8;
const MAX_TIPS = 2;
const LUNA_TIMEOUT_MS = 45_000;

export const LUNA_SYSTEM = [
  "You are Bee, a quiet meeting copilot shown in a small overlay.",
  "Give the user at most 2 short tips.",
  "Each tip is one line, starts with \"- \", and is under 20 words.",
  "If the latest transcript lines ask a direct question (a fact, a definition, a quick sum), the first tip answers it.",
  "Answer from the notes when they cover it and cite them by id, for example [n1].",
  "If the notes do not cover it and the fact is public, may have changed, or is current events (office holders, news, scores, prices, releases), use the web_search tool.",
  "After a search, end the tip with a short citation: the site domain, or [web]. Bee lists the source links.",
  "Do not search for stable general knowledge or arithmetic, for example 15% of 18000. Answer those directly.",
  "If the notes do not cover a question about the user's own notes or files, use list_dir, search_files and read_file, then answer from what you read.",
  "Prefer the notes above ([n1]…) first. Do not use web_search for private facts about the user's own work or files.",
  "Use append_note only when the user clearly asks to add or save a note.",
  "Otherwise, suggest what to say or do next, using the notes when they help and citing them.",
  "Never invent facts, figures or dates about the user's own work that are not in the transcript or notes.",
  "If nothing useful can be said, reply with exactly NONE.",
].join("\n");

/** Added to the system prompt only when the user has connected MCP tools. */
export const LUNA_MCP_SYSTEM = [
  "The user has connected MCP servers, for example vmem or Eva. Their tools are named server__tool, for example vmem__search.",
  "Call them when the transcript needs what those servers hold. Use them before guessing about the user's own data.",
  "If an MCP tool returns an error, say so briefly or skip it. Never invent a result.",
].join("\n");

export function noteCitation(index: number): string {
  return `n${index + 1}`;
}

export type LunaPrompt = { system: string; prompt: string };

export function buildLunaPrompt(args: { transcript: string[]; notes: Snippet[]; hasMcpTools?: boolean }): LunaPrompt {
  const lines = args.transcript.slice(-TRANSCRIPT_WINDOW).map((line) => `- ${line.trim()}`);
  const notes = args.notes.map((note, index) => `[${noteCitation(index)}] ${note.title}\n${note.text}`);
  const prompt = [
    "Recent transcript (oldest first):",
    lines.join("\n"),
    "",
    "Relevant notes:",
    notes.length > 0 ? notes.join("\n\n") : "(none)",
    "",
    "Tips:",
  ].join("\n");
  return { system: args.hasMcpTools ? `${LUNA_SYSTEM}\n${LUNA_MCP_SYSTEM}` : LUNA_SYSTEM, prompt };
}

export function parseLunaTips(text: string): string[] {
  if (text.trim().toUpperCase() === "NONE") return [];
  return text
    .split("\n")
    .map((line) => line.trim().replace(/^(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((line) => line.length > 0 && line.toUpperCase() !== "NONE")
    .slice(0, MAX_TIPS);
}

export async function guideWithLuna(args: {
  model: LanguageModel;
  transcript: string[];
  notes: Snippet[];
  timeoutMs?: number;
  /** Notes folder and extra approved folders for the file tools. Without notesDir, Luna gets no file tools. */
  notesDir?: string;
  extraRoots?: readonly string[];
  /** MCP tools from loadMcpTools. The caller closes the connections after the run. */
  extraTools?: ToolSet;
  /** Called with each tool Luna calls, so the overlay can show what it is doing. */
  onActivity?: (toolName: string) => void;
}): Promise<{ tips: string[]; sources: BeeSource[]; error: string | null }> {
  try {
    const { system, prompt } = buildLunaPrompt({ ...args, hasMcpTools: Object.keys(args.extraTools ?? {}).length > 0 });
    const result = await generateText({
      model: args.model,
      system,
      prompt,
      tools: lunaTools({ notesDir: args.notesDir, extraRoots: args.extraRoots, extra: args.extraTools }),
      stopWhen: isStepCount(5),
      // Local tools report as they start. Provider tools (web_search) report when their step finishes.
      onToolExecutionStart: ({ toolCall }) => args.onActivity?.(toolCall.toolName),
      onStepFinish: (step) => {
        for (const call of step.toolCalls) args.onActivity?.(call.toolName);
      },
      maxOutputTokens: 800,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(args.timeoutMs ?? LUNA_TIMEOUT_MS),
      providerOptions: { ...FLEX_PROVIDER_OPTIONS, openai: { reasoningEffort: "low" } },
    });
    return { tips: parseLunaTips(result.text), sources: sourcesFromGenerateResult(result), error: null };
  } catch (error) {
    return { tips: [], sources: [], error: `Luna guidance failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
