import { generateText, type LanguageModel } from "ai";
import { FLEX_PROVIDER_OPTIONS } from "./gateway";
import type { Snippet } from "./notes";

const TRANSCRIPT_WINDOW = 8;
const MAX_TIPS = 2;
const LUNA_TIMEOUT_MS = 30_000;

export const LUNA_SYSTEM = [
  "You are Bee, a quiet meeting copilot shown in a small overlay.",
  "Give the user at most 2 short tips.",
  "Each tip is one line, starts with \"- \", and is under 20 words.",
  "If the latest transcript lines ask a direct question (a fact, a definition, a quick sum), the first tip answers it.",
  "Answer from the notes when they cover it and cite them by id, for example [n1]; otherwise answer from general knowledge without a citation.",
  "If a general-knowledge answer may have changed since your training (for example, who holds an office), say so in a few words.",
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
}): Promise<{ tips: string[]; error: string | null }> {
  try {
    const { system, prompt } = buildLunaPrompt(args);
    const result = await generateText({
      model: args.model,
      system,
      prompt,
      maxOutputTokens: 800,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(args.timeoutMs ?? LUNA_TIMEOUT_MS),
      providerOptions: { ...FLEX_PROVIDER_OPTIONS, openai: { reasoningEffort: "low" } },
    });
    return { tips: parseLunaTips(result.text), error: null };
  } catch (error) {
    return { tips: [], error: `Luna guidance failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
