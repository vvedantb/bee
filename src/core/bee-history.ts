import type { ModelMessage } from "ai";

type ProviderOptions = NonNullable<ModelMessage["providerOptions"]>;

// What Bee and the user said to each other lately: the last few direct requests and what Bee did about them. Kept in the
// renderer store, sent with each new request, and given to the AI as real earlier turns, so "open the team usage" after
// "open Vercel usage" means the team usage on Vercel. Never the meeting: not in the session, the summary, meeting memory or
// the Teams sync. Pure: no window, React or Electron here, so tests can call it.

/** One request to Bee and how it ended. actions: desktop action lines ("Opened Vercel"). endedWhere: where computer use left the screen. */
export type BeeExchange = {
  request: string;
  reply: string;
  actions?: string[];
  endedWhere?: string;
  error?: string;
  at: number;
};

/** Exchanges kept: older ones drop off. */
export const HISTORY_MAX = 6;
/** No exchange with Bee for this long: the history clears, so an old subject never steers a new request. */
export const HISTORY_IDLE_MS = 10 * 60_000;
/** Rough budget for the history text sent to the AI (about 4 characters a token). Oldest exchanges go first. */
export const HISTORY_TOKENS_MAX = 8000;
const CHARS_PER_TOKEN = 4;
// Per field: a request or reply line is short, so these only stop a runaway.
export const HISTORY_TEXT_MAX = 2000;
const ACTIONS_MAX = 6;

const clip = (text: string, max = HISTORY_TEXT_MAX) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

/** The exchange as sent over IPC: fields clipped, empty optional fields left out. */
export function cleanExchange(exchange: BeeExchange): BeeExchange {
  const actions = (exchange.actions ?? []).map((line) => clip(line, 300)).filter(Boolean).slice(0, ACTIONS_MAX);
  const endedWhere = clip(exchange.endedWhere ?? "", 300);
  const error = clip(exchange.error ?? "", 300);
  return {
    request: clip(exchange.request),
    reply: clip(exchange.reply),
    ...(actions.length > 0 ? { actions } : {}),
    ...(endedWhere ? { endedWhere } : {}),
    ...(error ? { error } : {}),
    at: exchange.at,
  };
}

/** The history after one more exchange: newest last, at most HISTORY_MAX. */
export function addExchange(history: readonly BeeExchange[], exchange: BeeExchange): BeeExchange[] {
  return [...history, cleanExchange(exchange)].slice(-HISTORY_MAX);
}

/** The history as it stands at `now`: empty once the last exchange is HISTORY_IDLE_MS old. */
export function liveHistory(history: readonly BeeExchange[], now: number): BeeExchange[] {
  const last = history.at(-1);
  return last && now - last.at < HISTORY_IDLE_MS ? [...history] : [];
}

/** What Bee did, as the assistant turn: the reply, then the action lines, where it ended and any error. */
export function exchangeReply(exchange: BeeExchange): string {
  const lines = [
    ...(exchange.reply ? [exchange.reply] : []),
    ...(exchange.actions?.length ? [`Done: ${exchange.actions.join("; ")}`] : []),
    ...(exchange.endedWhere ? [`Ended: ${exchange.endedWhere}`] : []),
    ...(exchange.error ? [`Error: ${exchange.error}`] : []),
  ];
  return lines.length > 0 ? lines.join("\n") : "(no reply)";
}

const exchangeChars = (exchange: BeeExchange) => exchange.request.length + exchangeReply(exchange).length;

/** The newest exchanges that fit HISTORY_TOKENS_MAX (roughly), oldest dropped first. The newest always stays. */
export function trimHistory(history: readonly BeeExchange[], maxTokens = HISTORY_TOKENS_MAX): BeeExchange[] {
  const budget = maxTokens * CHARS_PER_TOKEN;
  const kept: BeeExchange[] = [];
  let used = 0;
  for (const exchange of [...history].reverse()) {
    used += exchangeChars(exchange);
    if (kept.length > 0 && used > budget) break;
    kept.unshift(exchange);
  }
  return kept;
}

/** The history as earlier turns for the model, oldest first: the user's request, then what Bee did. Trimmed to HISTORY_TOKENS_MAX. */
export function historyMessages(history: readonly BeeExchange[]): ModelMessage[] {
  return trimHistory(history).flatMap((exchange): ModelMessage[] => [
    { role: "user", content: [{ type: "text", text: exchange.request }] },
    { role: "assistant", content: [{ type: "text", text: exchangeReply(exchange) }] },
  ]);
}

/**
 * The messages with a cache breakpoint on the last part of the last one (the history is stable from one request to the next).
 * The caller passes the cache options (gateway.ts ANTHROPIC_CACHE) and keeps the request within CACHE_BREAKPOINTS_MAX.
 */
export function cacheAtEnd(messages: readonly ModelMessage[], cache: ProviderOptions): ModelMessage[] {
  const last = messages.at(-1);
  if (!last) return [];
  const content = typeof last.content === "string" ? [{ type: "text" as const, text: last.content }] : last.content;
  const end = content.length - 1;
  const marked = content.map((part, index) => (index === end ? { ...part, providerOptions: cache } : part));
  return [...messages.slice(0, -1), { ...last, content: marked } as ModelMessage];
}

/** Cache breakpoints in a request: the system and every message part with Anthropic cacheControl. Anthropic allows four. */
export function cacheBreakpoints(request: { instructions?: { providerOptions?: unknown }; messages: readonly ModelMessage[] }): number {
  const marked = (options: unknown) => Boolean((options as { anthropic?: { cacheControl?: unknown } } | undefined)?.anthropic?.cacheControl);
  let count = marked(request.instructions?.providerOptions) ? 1 : 0;
  for (const message of request.messages) {
    if (marked(message.providerOptions)) count += 1;
    if (Array.isArray(message.content)) for (const part of message.content) if (marked((part as { providerOptions?: unknown }).providerOptions)) count += 1;
  }
  return count;
}

/** Anthropic's limit on cache breakpoints per request. */
export const CACHE_BREAKPOINTS_MAX = 4;

/** A short line for a direct request that got no reply and did nothing: a question back for "the X one", else a plain line. */
export function commandFallbackReply(command: string): string {
  return /\b(?:one|ones|that|this|it|them|those|these|other)\b/i.test(command) ? "Which one?" : "Bee isn't sure what to do next.";
}
