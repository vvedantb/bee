import { generateText, isStepCount, type LanguageModel } from "ai";
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
  "Otherwise, suggest what to say or do next, using the notes when they help and citing them.",
  "Never invent facts, figures or dates about the user's own work that are not in the transcript or notes.",
  "If nothing useful can be said, reply with exactly NONE.",
].join("\n");

export function noteCitation(index: number): string {
  return `n${index + 1}`;
}

export type LunaPrompt = { system: string; prompt: string };

export function buildLunaPrompt(args: { transcript: string[]; notes: Snippet[] }): LunaPrompt {
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
  return { system: LUNA_SYSTEM, prompt };
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
}): Promise<{ tips: string[]; sources: BeeSource[]; error: string | null }> {
  try {
    const { system, prompt } = buildLunaPrompt(args);
    const result = await generateText({
      model: args.model,
      system,
      prompt,
      tools: lunaTools(),
      stopWhen: isStepCount(3),
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
