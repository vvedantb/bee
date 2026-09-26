import { generateText, type LanguageModel } from "ai";
import { FLEX_PROVIDER_OPTIONS } from "./gateway";

const SUMMARY_TIMEOUT_MS = 60_000;

// The model writes these sections; Bee adds the title and the notes and tips it used, so they are always accurate.
export const SUMMARY_SECTIONS = ["Decisions", "Action items", "Topics"];

export const SUMMARY_SYSTEM = [
  "You write a short markdown summary of a meeting from its transcript.",
  "Reply with exactly these three sections, in this order, each starting with a level-2 heading:",
  "## Decisions",
  "## Action items",
  "## Topics",
  "Under each heading write short bullet points starting with \"- \".",
  "For action items, start with the owner's name and a colon when the transcript names one, for example \"- Sam: send the quote\".",
  "Topics are one line each, naming the subject and what was said about it, so the note can be found by keyword next week.",
  "If a section has nothing, write \"- None recorded.\" under it.",
  "Use only facts from the transcript and the notes listed. Never invent names, figures or dates.",
  "No title, no preamble, no closing remarks.",
].join("\n");

export type SummaryInput = { transcript: string[]; notesCited?: string[]; tips?: string[] };

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Local time as YYYY-MM-DD HH:mm. */
export function summaryStamp(when: Date): string {
  const date = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
  return `${date} ${pad(when.getHours())}:${pad(when.getMinutes())}`;
}

/** meeting-YYYY-MM-DD-HHmm.md, in local time. */
export function summaryFileName(when: Date): string {
  return `meeting-${summaryStamp(when).replace(" ", "-").replace(":", "")}.md`;
}

function bullets(lines: string[], empty: string): string {
  const items = lines.map((line) => line.trim()).filter((line) => line.length > 0);
  return items.length > 0 ? items.map((line) => `- ${line}`).join("\n") : `- ${empty}`;
}

export function buildSummaryPrompt(args: SummaryInput): { system: string; prompt: string } {
  const prompt = [
    "Transcript (oldest first):",
    bullets(args.transcript, "(empty)"),
    "",
    "Notes shown during the meeting:",
    bullets(args.notesCited ?? [], "(none)"),
    "",
    "Summary:",
  ].join("\n");
  return { system: SUMMARY_SYSTEM, prompt };
}

/** Title first, then the given sections, then the notes and tips from the session. */
function assemble(when: Date, body: string, args: SummaryInput): string {
  const parts = [`# Meeting summary — ${summaryStamp(when)}`, body.trim(), `## Notes cited\n${bullets(args.notesCited ?? [], "None.")}`];
  if (args.tips && args.tips.length > 0) parts.push(`## Tips shown\n${bullets(args.tips, "None.")}`);
  return `${parts.join("\n\n")}\n`;
}

/**
 * Normalise the model's reply to the three expected sections. Drops code fences, titles and any preamble.
 * Returns null when a section is missing, so the caller falls back to the local summary.
 */
export function parseSummaryMarkdown(text: string): string | null {
  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !line.trim().startsWith("```") && !line.startsWith("# "));
  const start = lines.findIndex((line) => line.startsWith("## "));
  if (start === -1) return null;
  const body = lines.slice(start).join("\n").trim();
  const headings = new Set(lines.filter((line) => line.startsWith("## ")).map((line) => line.slice(3).trim().toLowerCase()));
  return SUMMARY_SECTIONS.every((section) => headings.has(section.toLowerCase())) ? body : null;
}

/**
 * Summary without a model (no key, or the call failed): same headings, so retrieval chunks it the same way,
 * with the transcript lines kept under Topics instead of an extracted summary.
 */
export function buildLocalSummary(args: SummaryInput & { when?: Date }): string {
  const body = [
    "## Decisions\n- Not extracted: saved without AI.",
    "## Action items\n- Not extracted: saved without AI.",
    `## Topics\n${bullets(args.transcript, "None recorded.")}`,
  ].join("\n\n");
  return assemble(args.when ?? new Date(), body, args);
}

/** Luna writes the summary. Fails open: on any error the local summary is returned with the reason. */
export async function generateMeetingSummary(
  args: SummaryInput & { model: LanguageModel; when?: Date; timeoutMs?: number },
): Promise<{ markdown: string; usedLlm: boolean; error: string | null }> {
  const when = args.when ?? new Date();
  try {
    const { system, prompt } = buildSummaryPrompt(args);
    const result = await generateText({
      model: args.model,
      system,
      prompt,
      maxOutputTokens: 2000,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(args.timeoutMs ?? SUMMARY_TIMEOUT_MS),
      providerOptions: { ...FLEX_PROVIDER_OPTIONS, openai: { reasoningEffort: "low" } },
    });
    const body = parseSummaryMarkdown(result.text);
    if (!body) throw new Error("reply did not have the expected sections");
    return { markdown: assemble(when, body, args), usedLlm: true, error: null };
  } catch (error) {
    return {
      markdown: buildLocalSummary({ ...args, when }),
      usedLlm: false,
      error: `Luna summary failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
