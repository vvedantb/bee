import { createHash } from "node:crypto";
import type { BeeExchange } from "./bee-history";
import { redactSecretValues } from "./debug-redact";

// A finished Bee session as plain text for vmem's transcript_submit (core/vmem-transcript.ts). Pure: no Electron, no fs.
//
// Bee has two finished-session seams, and only these two count:
// - A meeting: the lines said and the AI's tips, sent when its summary is written (main/meeting-ipc.ts writeMeetingSummary).
// - A conversation: the user's direct requests to Bee and what the AI did (BeeExchange, core/bee-history.ts), sent after
//   CONVERSATION_IDLE_MS with no exchange (or CONVERSATION_EXCHANGES_MAX of them). That is only a session boundary: Bee's
//   history for the AI is kept whole. A conversation that ends with a meeting is not sent: the meeting send covers it.
//
// Secrets are taken out with the debug log's value patterns plus a "password: …" rule, and the text is cut under vmem's 1.5 MB.

export type SessionKind = "meeting" | "conversation";

/** A transcript ready to queue: a stable id for dedupe, a title, and the redacted, size-safe text. */
export type SessionTranscript = { id: string; kind: SessionKind; title: string; transcript: string; createdAt: number };

export type MeetingSessionInput = {
  transcript: ReadonlyArray<string | { speaker: string; text: string }>;
  tips?: readonly string[];
  notesCited?: readonly string[];
  /** The detected meeting's name, when Bee knows it. */
  subject?: string;
  when: Date;
};

/** title: the session's short name. text: the whole transcript. body: what was said and done, without the title and date lines. */
export type Rendered = { title: string; text: string; body: string };

export type ConversationSessionInput = { exchanges: readonly BeeExchange[]; when: Date };

/** vmem refuses a transcript over 1.5 MB UTF-8. Bee stays under 1.4 MB, so the notice and any count drift never cross it. */
export const TRANSCRIPT_MAX_BYTES = 1_400_000;
const AI = "The AI";
const USER = "User";
const TITLE_MAX = 200;

const pad = (value: number) => String(value).padStart(2, "0");
/** Local date as YYYY-MM-DD. */
export const isoDate = (when: Date) => `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
/** Local time as HH:mm. */
export const clockTime = (when: Date) => `${pad(when.getHours())}:${pad(when.getMinutes())}`;
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

// "password: hunter2", "api_key=abc123": the value after a secret's label. Spoken or typed, so the debug log's key rules miss it.
// "is" only after a password-like label: "the token is expired" stays readable.
const LABELLED_SECRET = /\b(password|passwd|passcode|pwd|api[ _-]?key|secret|token|access[ _-]?key)(\s*[:=]\s*)(?!\[redacted)["']?[^\s"',;]{4,}["']?/gi;
const SPOKEN_SECRET = /\b(password|passcode|pin)(\s+is\s+)(?!\[redacted)["']?[^\s"',;]{4,}["']?/gi;

/** The text with obvious secrets replaced: provider keys, JWTs, Bearer tokens, secrets in URLs, and "password: …" values. */
export function redactTranscript(text: string): string {
  return redactSecretValues(text).replace(LABELLED_SECRET, "$1$2[redacted]").replace(SPOKEN_SECRET, "$1$2[redacted]");
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Byte length of the text as UTF-8. */
export const utf8Bytes = (text: string) => encoder.encode(text).length;

/**
 * The text whole when it fits `maxBytes` of UTF-8, else its start cut at a line break (or a character boundary when no line break
 * is near) with a one-line notice. Never splits a character, so the result is always valid UTF-8 within maxBytes.
 */
export function truncateUtf8(text: string, maxBytes = TRANSCRIPT_MAX_BYTES): string {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  const notice = (dropped: number) => `\n\n[Transcript cut: ${dropped} more bytes not sent]`;
  // Room for the notice at its longest (every byte dropped).
  const budget = Math.max(0, maxBytes - utf8Bytes(notice(bytes.length)));
  let end = budget;
  // Step back off UTF-8 continuation bytes (10xxxxxx) so the cut lands on the start of a character.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  let head = decoder.decode(bytes.subarray(0, end));
  // A line break in the last quarter is a cleaner cut; further back loses too much.
  const lineEnd = head.lastIndexOf("\n");
  if (lineEnd > head.length * 0.75) head = head.slice(0, lineEnd);
  return `${head}${notice(bytes.length - utf8Bytes(head))}`;
}

/** sha256 of the kind and text: the same session gives the same id, so it is never sent twice. */
export function sessionId(kind: SessionKind, text: string): string {
  return `${kind}:${createHash("sha256").update(`${kind}\n${text}`).digest("hex").slice(0, 32)}`;
}

/** The meeting as text: title, date, what was said (speaker when known), then the AI's tips and cited notes. */
export function renderMeeting(input: MeetingSessionInput): Rendered {
  const subject = oneLine(input.subject ?? "");
  const title = (subject ? `${subject} — ${isoDate(input.when)}` : `Meeting — ${isoDate(input.when)}`).slice(0, TITLE_MAX);
  const said = input.transcript
    .map((line) => (typeof line === "string" ? oneLine(line) : oneLine(line.text) ? `${oneLine(line.speaker) || "Someone"}: ${oneLine(line.text)}` : ""))
    .filter(Boolean);
  if (said.length === 0) return { title, text: "", body: "" };
  const tips = (input.tips ?? []).map(oneLine).filter(Boolean);
  const notes = (input.notesCited ?? []).map(oneLine).filter(Boolean);
  const body = [
    "What was said:",
    ...said,
    ...(tips.length > 0 ? ["", "Tips from the AI:", ...tips.map((tip) => `- ${tip}`)] : []),
    ...(notes.length > 0 ? ["", "Notes cited:", ...notes.map((note) => `- ${note}`)] : []),
  ].join("\n");
  return { title, text: [title, `Date: ${isoDate(input.when)} ${clockTime(input.when)}`, "Source: Bee meeting", "", body].join("\n"), body };
}

/** The conversation as text: title, date, then each request and what the AI did (reply, actions, where it ended, any error). */
export function renderConversation(input: ConversationSessionInput): Rendered {
  const title = `Conversation — ${isoDate(input.when)} ${clockTime(input.when)}`;
  const turns = input.exchanges.flatMap((exchange) => {
    const request = oneLine(exchange.request);
    const reply = oneLine(exchange.reply);
    const actions = (exchange.actions ?? []).map(oneLine).filter(Boolean);
    const endedWhere = oneLine(exchange.endedWhere ?? "");
    const error = oneLine(exchange.error ?? "");
    if (!request && !reply && actions.length === 0 && !error) return [];
    const at = clockTime(new Date(exchange.at));
    return [
      "",
      `[${at}] ${USER}: ${request || "(no words)"}`,
      `[${at}] ${AI}: ${reply || "(no reply)"}`,
      ...actions.map((action) => `  Action: ${action}`),
      ...(endedWhere ? [`  Ended: ${endedWhere}`] : []),
      ...(error ? [`  Error: ${error}`] : []),
    ];
  });
  if (turns.length === 0) return { title, text: "", body: "" };
  const body = turns.join("\n");
  return { title, text: [title, `Date: ${isoDate(input.when)} ${clockTime(input.when)}`, "Source: Bee conversation", body].join("\n"), body };
}

/**
 * Redacted and size-safe. The id hashes the body only (not the title or the send time), so the same lines give the same id
 * however late they are queued. null when nothing was said: an empty session is never sent.
 */
function finish(kind: SessionKind, rendered: Rendered, when: Date): SessionTranscript | null {
  if (!rendered.body.trim()) return null;
  const transcript = truncateUtf8(redactTranscript(rendered.text));
  return { id: sessionId(kind, rendered.body), kind, title: redactTranscript(rendered.title), transcript, createdAt: when.getTime() };
}

export function meetingTranscript(input: MeetingSessionInput): SessionTranscript | null {
  return finish("meeting", renderMeeting(input), input.when);
}

export function conversationTranscript(input: ConversationSessionInput): SessionTranscript | null {
  return finish("conversation", renderConversation(input), input.when);
}
