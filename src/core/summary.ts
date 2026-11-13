import { generateText, type LanguageModel, type SystemModelMessage, type UserModelMessage } from "ai";
import { debugLog, errorData, modelName, msSince, onceText } from "./debug-log";
import { ANTHROPIC_CACHE, guideProviderOptions } from "./gateway";
import { PEOPLE_SECTION_RULES, splitPeopleSection, type LearnedPerson } from "./people";

// Long enough for a whole long meeting (ipc.ts SESSION_TRANSCRIPT_MAX lines).
const SUMMARY_TIMEOUT_MS = 120_000;

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

// Added to the system prompt when the transcript is speaker-labelled (captions or call audio).
export const SPEAKER_RULES = [
  "Each transcript line starts with the speaker's name and a colon.",
  "Use the names to attribute decisions and action items. When a speaker commits to a task (\"I'll send it\"), that speaker is the owner.",
  "The transcript only has what Bee heard or read in the call. Do not guess what others said.",
].join("\n");

// Added when a meeting or call was heard only through the mic: lines are unlabelled and may include other people.
export const ATTRIBUTION_UNKNOWN_RULES = [
  "The transcript lines are unlabelled. Bee heard only the mic, not the meeting audio, so lines may include other people heard through the speakers.",
  "Do not assume the user said any line. Do not attribute decisions or action items to anyone, and do not invent names.",
  "For every action item, write \"Owner unknown\" instead of a name, for example \"- Owner unknown: send the quote\".",
].join("\n");

export const ATTRIBUTION_UNAVAILABLE = "Attribution unavailable: Bee heard only the mic, not the meeting audio";

// A plain line (solo, the speaker is the user) or a speaker-labelled line from a synced meeting.
export type TranscriptLine = string | { speaker: string; text: string };

export type SummaryInput = {
  transcript: TranscriptLine[];
  notesCited?: string[];
  tips?: string[];
  /** A meeting or call heard only through the mic: nobody can be named as speaker or owner. */
  attributionUnknown?: boolean;
  /** The people the user knows, as a block for the AI (core/people.ts peopleBlock). Names and topics only. */
  people?: string;
  /** Ask for each speaker's topics too (core/people.ts PEOPLE_SECTION_RULES). Only used when the transcript names its speakers. */
  learnPeople?: boolean;
};

const PLACEHOLDER_OWNER = /^\s*(?:\*\*)?speaker(?:\s*#?\d+)?(?:\*\*)?\s*:\s*/i;

/** Replaces an invented "Speaker:" or "Speaker 2:" owner with "Owner unknown". Real names are untouched. */
export function scrubPlaceholderOwner(item: string): string {
  return PLACEHOLDER_OWNER.test(item) ? item.replace(PLACEHOLDER_OWNER, "Owner unknown: ") : item;
}

function scrubActionItems(body: string): string {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  let inActions = false;
  return lines
    .map((line) => {
      if (line.startsWith("## ")) inActions = line.slice(3).trim().toLowerCase() === "action items";
      const match = inActions ? /^(\s*[-*]\s+)(.*)$/.exec(line) : null;
      return match ? `${match[1]}${scrubPlaceholderOwner(match[2] ?? "")}` : line;
    })
    .join("\n");
}

export function lineText(line: TranscriptLine): string {
  return typeof line === "string" ? line : `${line.speaker.trim()}: ${line.text.trim()}`;
}

/** Speakers in order of first line, when the transcript is labelled; empty for a solo transcript. */
export function transcriptSpeakers(transcript: TranscriptLine[]): string[] {
  const names = transcript.flatMap((line) => (typeof line === "string" ? [] : [line.speaker.trim()]));
  return [...new Set(names)];
}

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
  const speakers = transcriptSpeakers(args.transcript);
  const header = speakers.length > 0 ? [`Speakers: ${speakers.join(", ")}`, "Transcript (oldest first, \"Speaker: words\"):"] : ["Transcript (oldest first):"];
  const prompt = [
    ...header,
    bullets(args.transcript.map(lineText), "(empty)"),
    "",
    "Notes shown during the meeting:",
    bullets(args.notesCited ?? [], "(none)"),
    "",
    "Summary:",
  ].join("\n");
  const labelled = speakers.length > 0 ? `${SUMMARY_SYSTEM}\n${SPEAKER_RULES}` : SUMMARY_SYSTEM;
  const system = speakers.length > 0 && args.learnPeople ? `${labelled}\n${PEOPLE_SECTION_RULES}` : labelled;
  const rules = args.attributionUnknown && speakers.length === 0 ? `${system}\n${ATTRIBUTION_UNKNOWN_RULES}` : system;
  // After the fixed rules, so those stay one cached prefix when the list changes.
  return { system: args.people ? `${rules}\n\n${args.people}` : rules, prompt };
}

/** The system first, with a cache breakpoint (gateway.ts ANTHROPIC_CACHE), then the transcript. */
export function summaryRequest(prompt: { system: string; prompt: string }): { instructions: SystemModelMessage; messages: UserModelMessage[] } {
  return {
    instructions: { role: "system", content: prompt.system, providerOptions: ANTHROPIC_CACHE },
    messages: [{ role: "user", content: prompt.prompt }],
  };
}

/** Title first, then the given sections, the speakers (if any), then the notes and tips from the session. */
function assemble(when: Date, body: string, args: SummaryInput): string {
  const parts = [`# Meeting summary — ${summaryStamp(when)}`, scrubActionItems(body).trim()];
  const speakers = transcriptSpeakers(args.transcript);
  if (speakers.length === 0 && args.attributionUnknown) {
    parts.push(`## Speakers\n${bullets([ATTRIBUTION_UNAVAILABLE], "None.")}`);
  } else if (speakers.length > 0) {
    parts.push(`## Speakers\n${bullets([...speakers, "Partial: only what Bee heard or read in the call is captured."], "None.")}`);
  }
  parts.push(`## Notes cited\n${bullets(args.notesCited ?? [], "None.")}`);
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

const EMPTY_ITEM = /^(none recorded\.?|none\.?|not extracted: saved without ai\.?)$/i;

function sectionBullets(markdown: string, heading: string): string[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start === -1) return [];
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    const match = /^\s*[-*]\s+(.*\S)\s*$/.exec(line);
    if (match && !EMPTY_ITEM.test(match[1] ?? "")) items.push(match[1] as string);
  }
  return items;
}

/** Decisions, action items and topics from a summary's markdown (Luna's or the local one), for meeting memory. Placeholders are dropped. */
export function extractSummaryFields(markdown: string): { decisions: string[]; actionItems: string[]; topics: string[] } {
  return {
    decisions: sectionBullets(markdown, "Decisions"),
    actionItems: sectionBullets(markdown, "Action items").map(scrubPlaceholderOwner),
    topics: sectionBullets(markdown, "Topics"),
  };
}

/**
 * Summary without a model (no key, or the call failed): same headings, so retrieval chunks it the same way,
 * with the transcript lines kept under Topics instead of an extracted summary.
 */
export function buildLocalSummary(args: SummaryInput & { when?: Date }): string {
  const body = [
    "## Decisions\n- Not extracted: saved without AI.",
    "## Action items\n- Not extracted: saved without AI.",
    `## Topics\n${bullets(args.transcript.map(lineText), "None recorded.")}`,
  ].join("\n\n");
  return assemble(args.when ?? new Date(), body, args);
}

/** Luna writes the summary. Fails open: on any error the local summary is returned with the reason. */
export async function generateMeetingSummary(
  args: SummaryInput & { model: LanguageModel; when?: Date; timeoutMs?: number },
): Promise<{ markdown: string; usedLlm: boolean; error: string | null; people: LearnedPerson[] }> {
  const when = args.when ?? new Date();
  const started = performance.now();
  try {
    const prompt = buildSummaryPrompt(args);
    debugLog.info("ai", "summary-request", { model: modelName(args.model), system: onceText(prompt.system), prompt: prompt.prompt });
    const result = await generateText({
      model: args.model,
      ...summaryRequest(prompt),
      maxOutputTokens: 3000,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(args.timeoutMs ?? SUMMARY_TIMEOUT_MS),
      // Background work: flex, Anthropic first (no web search, so fail-over stays). Flex may not apply on Anthropic.
      // Thinking off: a structured extraction gains nothing from it, and reasoning would eat the output budget.
      providerOptions: guideProviderOptions("flex", { web: false }),
    });
    debugLog.info("ai", "summary-response", { ms: msSince(started), finishReason: result.finishReason, text: result.text, usage: result.totalUsage });
    const reply = parseSummaryMarkdown(result.text);
    if (!reply) throw new Error("reply did not have the expected sections");
    // The People section is for Bee's own memory of people: filed by the caller, never part of the note.
    const { body, people } = splitPeopleSection(reply, transcriptSpeakers(args.transcript));
    return { markdown: assemble(when, body, args), usedLlm: true, error: null, people };
  } catch (error) {
    debugLog.warn("ai", "summary-failed", { ms: msSince(started), error: errorData(error) });
    return {
      markdown: buildLocalSummary({ ...args, when }),
      usedLlm: false,
      people: [],
      error: `AI summary failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
