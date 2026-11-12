import { z } from "zod";
import { HEADED_FLAG, REF_PATTERN, STDIN_FLAG, parseApps, type AgentDesktopData, type AgentDesktopResult, type ComputerRun } from "./agent-desktop-envelope";
import { isTeamsApp } from "./app-playbooks";
import { awaitAnswer, CONFIRM_TIMEOUT_MS, type ComputerPlatform, type IrreversibleKind, type RunControl } from "./computer-control";
import { createExec, modKey, pasteText, type Exec, type PasteOutcome } from "./computer-exec";
import { shortName } from "./computer-gate";
import { CONFIRM_LABEL, fieldValue, keyPresses, matchApp, windowsAlias, type ConfirmRequest } from "./computer-tools";
import { debugLog, msSince } from "./debug-log";
import type { DesktopActions } from "./desktop-actions";
import { nameMatches, type ResolvedName } from "./known-names";

// "Bee, message Sam on Teams saying I'm running late": a fixed recipe that code runs, step by step, instead of the AI. Teams (a
// WebView2 app) often refuses semantic clicks and misreports its compose box, so the AI loop is slow and unsure there; the steps
// that always work are the keyboard's. parseTeamsMessage is conservative: Teams named, a person or chat, and the words to send,
// else null and the request goes to the AI as before. runTeamsRecipe opens Teams, types the name in its search (ctrl+e or cmd+e,
// then a check that the box shows it), picks the result that names the person with Down and Return, and checks that chat really
// opened (the chat list's selected row, the window title or the header names the person) before it writes anything;
// when it cannot tell, it stops and hands the task to the AI with what it did. It pastes the message (the clipboard's old text
// goes back after), reads the box back, types it once if the paste did not take, and sends only after the user's Confirm. Nothing
// is ever typed into a chat Bee could not check, a box that already holds the user's own draft is left alone, and Stop ends it
// between any two steps. Logs carry step names, outcomes and times, never the name or the message.

export type TeamsMessage = {
  to: string;
  text: string;
  send: boolean;
  /** Only open and check the chat: write nothing (text is ignored). */
  openOnly?: boolean;
  /** With openOnly: also read the open chat's latest messages (the Bee MCP server's teams_read_chat). */
  read?: boolean;
};

// Polite padding before the request, and quotes around it.
const POLITE = /^(?:(?:please|hey|ok|okay|so|now|just|can you|could you|would you|will you)[\s,]+)+/i;
const TEAMS = String.raw`(?:microsoft\s+|ms\s+)?teams`;
// A person or chat: one to four words of letters (any script), with ' . - inside.
const NAME = String.raw`[\p{L}][\p{L}'’.-]*(?:\s+[\p{L}][\p{L}'’.-]*){0,3}`;
const SEND_VERB = String.raw`(?:message|tell|text|ping|dm|send\s+(?:a\s+)?(?:${TEAMS}\s+)?message\s+to)`;
const DRAFT_VERB = String.raw`(?:draft|write|prepare|compose)\s+(?:a\s+)?(?:${TEAMS}\s+)?(?:message|reply|note)\s+(?:to|for)`;
// What comes between the name and the words: "saying", "that", a colon or comma, a dash with spaces round it.
const SAYING = String.raw`(?:\s*[:,]\s*|\s+[–—-]\s+|\s+(?:saying|say|that|to say)\s*:?\s*)`;
const IN_TEAMS = String.raw`(?:in|on|via|over|through|using)\s+${TEAMS}`;
const WHERE = String.raw`\s+${IN_TEAMS}`;
// The words, then where: "… saying hi on Teams".
const TEXT_THEN_WHERE = String.raw`(?<text>.+?)[\s,]+${IN_TEAMS}[.!]?$`;

const PATTERNS: readonly { pattern: RegExp; send: boolean }[] = [
  // message Sam on Teams saying hi / tell Sam in Teams that I'm late / draft a message to Sam on Teams saying hi
  { pattern: new RegExp(String.raw`^${SEND_VERB}\s+(?<to>${NAME})${WHERE}${SAYING}(?<text>.+)$`, "iu"), send: true },
  { pattern: new RegExp(String.raw`^${DRAFT_VERB}\s+(?<to>${NAME})${WHERE}${SAYING}(?<text>.+)$`, "iu"), send: false },
  // message Sam saying hi on Teams
  { pattern: new RegExp(String.raw`^${SEND_VERB}\s+(?<to>${NAME}?)${SAYING}${TEXT_THEN_WHERE}`, "iu"), send: true },
  { pattern: new RegExp(String.raw`^${DRAFT_VERB}\s+(?<to>${NAME}?)${SAYING}${TEXT_THEN_WHERE}`, "iu"), send: false },
  // send Sam a Teams message: hi / send Sam a message on Teams saying hi / send a Teams message to Sam saying hi
  { pattern: new RegExp(String.raw`^send\s+(?<to>${NAME}?)\s+an?\s+${TEAMS}\s+message${SAYING}(?<text>.+)$`, "iu"), send: true },
  { pattern: new RegExp(String.raw`^send\s+(?<to>${NAME}?)\s+a\s+message${WHERE}${SAYING}(?<text>.+)$`, "iu"), send: true },
  { pattern: new RegExp(String.raw`^send\s+an?\s+${TEAMS}\s+message\s+to\s+(?<to>${NAME}?)${SAYING}(?<text>.+)$`, "iu"), send: true },
  // reply to Sam in Teams with sounds good
  { pattern: new RegExp(String.raw`^reply\s+to\s+(?<to>${NAME})${WHERE}(?:${SAYING}|\s+with\s+)(?<text>.+)$`, "iu"), send: true },
  // on Teams, message Sam saying hi
  { pattern: new RegExp(String.raw`^${IN_TEAMS}[\s,]+${SEND_VERB}\s+(?<to>${NAME}?)${SAYING}(?<text>.+)$`, "iu"), send: true },
];

// Words that are no person to look up: pronouns, "everyone", and the app itself.
const NOT_A_NAME = /^(?:him|her|them|us|it|this|that|everyone|everybody|all|someone|somebody|teams|microsoft|chat|group|channel|you)$/i;
// The user's own chat in Teams (the one marked "(You)"): "message myself", "send me a note".
const SELF = /^(?:me|myself|my ?self|my own chat|my notes chat)$/i;
/** The name Bee uses for the user's own chat until the recipe reads it from Teams' chat list. */
export const SELF_CHAT = "me";
/** Who a Teams message is for, as the AI or the user named it: "myself" and "me" are the user's own chat. */
export const teamsRecipient = (to: string): string => (SELF.test(to.trim()) ? SELF_CHAT : to.trim());
// "Open Teams and …" / "go to Teams, then …": Teams is named first, so the rest is read as if it ended "on Teams".
const OPEN_TEAMS_FIRST = new RegExp(String.raw`^(?:open|go to|switch to|bring up)\s+${TEAMS}\s*(?:,|\band\b|\bthen\b)+\s*(?:then\s+)?(?<rest>.+)$`, "iu");
const TEXT_MAX = 2000;

/** "Bee, message Sam on Teams saying hi" as { to: "Sam", text: "hi", send: true }, or null for anything it is not sure of. */
export function parseTeamsMessage(command: string): TeamsMessage | null {
  const asked = command.replace(/\s+/g, " ").trim().replace(/^["“](.*)["”]$/u, "$1").replace(POLITE, "").trim();
  const rest = OPEN_TEAMS_FIRST.exec(asked)?.groups?.rest?.replace(/[.!]$/, "");
  const said = rest ? `${rest} on Teams` : asked;
  for (const { pattern, send } of PATTERNS) {
    const match = pattern.exec(said);
    const named = (match?.groups?.to ?? "").replace(/^the\s+/i, "").trim();
    const to = SELF.test(named) ? SELF_CHAT : named.replace(/\s+(?:group\s+)?chat$/i, "").trim();
    const text = (match?.groups?.text ?? "").trim().replace(/^["“‘']+(.*?)["”’']+$/u, "$1").trim();
    if (!match || !to || !text || text.length > TEXT_MAX) continue;
    if (to.split(" ").some((word) => NOT_A_NAME.test(word))) return null;
    return { to, text, send };
  }
  return null;
}

/**
 * The name to search Teams for: the one the user's recent requests settled (resolved), else the only known name it matches
 * (core/known-names.ts: "Zuzanna" for "Susannah"), else the name as said.
 */
export function recipientName(to: string, known: readonly string[], resolved: readonly ResolvedName[] = []): string {
  if (to === SELF_CHAT) return SELF_CHAT;
  const settled = resolved.find((item) => item.heard.toLowerCase() === to.toLowerCase() || item.heard.toLowerCase() === to.split(" ")[0]?.toLowerCase());
  if (settled) return settled.name;
  if (to.includes(" ")) return to;
  const matches = nameMatches(to, known);
  return matches.length === 1 && matches[0] ? matches[0].name : to;
}

/** Letters only, lower case, no accents: "Zoë Łukasz-Nowak" → "zoe łukasz nowak". */
const fold = (text: string) => ` ${text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;

/** The words a chat's title must hold for this name: its first and last (one word for a one-word name). */
export function nameWords(name: string): string[] {
  const words = fold(name).trim().split(" ").filter((word) => word.length >= 2);
  return words.length <= 1 ? words : [words[0] ?? "", words.at(-1) ?? ""];
}

/** A title or header names this person or chat: every word of nameWords, as whole words, any case or accent. */
export function namesChat(title: string, name: string): boolean {
  const words = nameWords(name);
  const hay = fold(title);
  return words.length > 0 && words.every((word) => hay.includes(` ${word} `));
}

/** The user's name from their own chat's row: "Chat Vedant Bhopatrao (You) You: btw…" → "Vedant Bhopatrao". Null for any other row. */
export function ownName(row: string): string | null {
  const name = /^(?:chat\s+)?(.+?)\s*\(you\)/i.exec(row.trim())?.[1]?.trim();
  return name && name.length <= 80 ? name : null;
}

/** Text as Bee compares a field with what it wrote: no zero-width marks, runs of space as one, trimmed. */
const squash = (text: string) => text.replace(/[​-‍﻿]/g, "").replace(/\s+/g, " ").trim();

// ref_id is null for what cannot be acted on (a chat's header); value is a field's text; states holds "selected" for a chosen row.
const matchSchema = z.object({
  ref_id: z.string().nullish().catch(null),
  role: z.string().optional().catch(undefined),
  name: z.string().nullish().catch(null),
  value: z.string().nullish().catch(null),
  states: z.array(z.string()).optional().catch(undefined),
  // Where it sits: "window:…", "group", "listbox:Suggestions", …
  path: z.array(z.string()).optional().catch(undefined),
});
const matchesSchema = z.object({ matches: z.array(matchSchema.nullable().catch(null)) });
type Match = z.infer<typeof matchSchema>;

/** find's matches (agent-desktop: { matches: [{ ref_id, role, name }] }), the unreadable ones dropped. */
function findMatches(data: AgentDesktopData): Match[] {
  const parsed = matchesSchema.safeParse(data);
  return parsed.success ? parsed.data.matches.filter((match) => match !== null) : [];
}

// agent-desktop's refusal when no element of the app holds the keyboard.
const NO_KEYBOARD = /keyboard focus/i;
const windowRowSchema = z.object({ id: z.string(), is_focused: z.boolean().optional().catch(undefined) }).nullable().catch(null);
const windowRowsSchema = z.union([z.array(windowRowSchema), z.object({ windows: z.array(windowRowSchema) }).transform((data) => data.windows)]);

const windowsSchema = z.union([
  z.array(z.object({ title: z.string().optional().catch(undefined) }).nullable().catch(null)),
  z.object({ windows: z.array(z.object({ title: z.string().optional().catch(undefined) }).nullable().catch(null)) }).transform((data) => data.windows),
]);

// A message box by its name in Teams ("Type a message", "Type a reply"), never a search box.
const COMPOSE_NAME = /\b(?:type a (?:new )?(?:message|reply)|message|reply|compose)\b/i;
const SEARCH_NAME = /\b(?:search|find|filter|look ?up)\b/i;

/**
 * The search result to open for this name: its place in the list, "several" when results name two different people or chats, or
 * null when none names it. A result that starts with the name wins ("George" opens "George Dowling", not the group chat "Sam Lee,
 * George Dowling"); Teams' own "Search for …" row never counts.
 */
export function pickResult(names: readonly string[], name: string): number | "several" | null {
  const rows = names.map((text, index) => ({ text, index })).filter(({ text }) => !SEARCH_NAME.test(text) && namesChat(text, name));
  const leading = rows.filter(({ text }) => fold(text).startsWith(fold(name)));
  const best = leading.length > 0 ? leading : rows;
  if (new Set(best.map(({ text }) => fold(text))).size > 1) return "several";
  return best[0]?.index ?? null;
}

/** The message box among find's text fields: one named like Teams' compose box ("Type a message" first), or null. */
export function composeRef(matches: readonly Match[]): string | null {
  const boxes = matches.filter((match) => match.ref_id && REF_PATTERN.test(match.ref_id) && COMPOSE_NAME.test(match.name ?? "") && !SEARCH_NAME.test(match.name ?? ""));
  const best = boxes.find((match) => /type a (?:new )?message/i.test(match.name ?? "")) ?? boxes[0];
  return best?.ref_id ?? null;
}

export type RecipeDeps = {
  run: ComputerRun;
  desktop: DesktopActions;
  control: RunControl;
  platform: ComputerPlatform;
  confirm: (request: ConfirmRequest, signal: AbortSignal) => Promise<boolean>;
  onStep?: ((label: string) => void) | undefined;
  yieldFocus?: (() => () => void) | undefined;
  /** The send went out (the box emptied after Return): proof for the claim guard (core/claim-guard.ts). */
  onEffect?: ((kind: IrreversibleKind) => void) | undefined;
  confirmTimeoutMs?: number;
  /** Pauses between keyboard steps (Teams' search fills in as it is typed); tests set 0. */
  pauseMs?: { search: number; results: number; open: number; sent: number };
};

/**
 * sent: Return went out and the box emptied. drafted: the message is in the box, unsent (asked for a draft, or Cancel). failed: an
 * honest line, nothing sent, no AI after. fallback: Bee could not be sure of a step before any text was written; the AI carries on
 * from done. stopped: Stop or a newer request.
 */
export type RecipeOutcome =
  | { kind: "sent"; line: string }
  | { kind: "drafted"; line: string }
  | { kind: "opened"; line: string; /** With read: the latest messages, oldest first, as Teams labels them. */ messages?: string[] }
  | { kind: "failed"; line: string }
  | { kind: "fallback"; done: string }
  | { kind: "stopped" };

const PAUSES = { search: 700, results: 1500, open: 2000, sent: 1000 };
const KEY_MS = 12_000;
const READ_MS = 15_000;
const LOOK_MS = 12_000;
const TYPE_MS = 40_000;
/** The longest name typed key by key; a longer one, or one with a character no key types, is pasted. */
const NAME_KEYS_MAX = 60;
const TEAMS_LABEL = "Microsoft Teams";

/** Runs the recipe for one parsed request. Never throws. */
export async function runTeamsRecipe(asked: TeamsMessage & { name: string }, deps: RecipeDeps): Promise<RecipeOutcome> {
  const self = asked.name === SELF_CHAT;
  // For the user's own chat, the name comes from Teams' chat list once Teams is open (step 1).
  let message = asked;
  const { control, platform } = deps;
  const pauses = deps.pauseMs ?? PAUSES;
  const exec: Exec = createExec(deps);
  const started = performance.now();
  let first = self ? "you" : shortName(message.name.split(" ")[0] ?? message.name, 30);
  const stopped = () => control.reason() !== null;
  /** One step's outcome in the log: its name, whether it worked, how long it took. Never the name or the message. */
  const logged = <T>(step: string, ok: (value: T) => boolean) => async (work: Promise<T>): Promise<T> => {
    const at = performance.now();
    const value = await work;
    debugLog.info("computer", "teams-recipe", { step, ok: ok(value), ms: msSince(at) });
    return value;
  };
  const okResult = (result: AgentDesktopResult) => result.ok;
  const pause = (ms: number) => (ms > 0 && !stopped() ? exec("wait", [String(ms)], ms + 5000) : Promise.resolve<AgentDesktopResult>({ ok: true, data: null }));
  const done: string[] = [];
  const fallback = (why: string): RecipeOutcome => {
    debugLog.info("computer", "teams-recipe-fallback", { steps: done.length, ms: msSince(started) });
    return { kind: "fallback", done: `${done.join(" ")} ${why}`.trim() };
  };

  // 1. Teams in front, and its name as agent-desktop knows it (ms-teams.exe on Windows).
  deps.onStep?.(self ? "Opening your own chat…" : `Opening the chat with ${first}…`);
  const opened = await logged("open", (result: { ok: boolean }) => result.ok)(deps.desktop.openApp(TEAMS_LABEL, control.signal));
  if (stopped()) return { kind: "stopped" };
  const listed = await logged("list-apps", okResult)(exec("list-apps", [], READ_MS));
  const running = listed.ok ? parseApps(listed.data).map((app) => app.name) : [];
  const teamsApps = running.filter(isTeamsApp);
  // A launch that failed is fine when Teams is already running (the keys below go to it).
  if (!opened.ok && teamsApps.length === 0) return fallback("Bee could not open Microsoft Teams.");
  done.push("Bee opened Microsoft Teams.");
  const app = matchApp(TEAMS_LABEL, teamsApps) ?? (teamsApps.length === 1 ? teamsApps[0] : null) ?? (platform === "windows" ? windowsAlias(TEAMS_LABEL) : null) ?? TEAMS_LABEL;
  const where = [`--app=${app}`];
  // Keys go to Teams' process (--app). When Teams holds the keyboard in a window of its own (its search popup), agent-desktop
  // refuses them for that scope ("no verified keyboard focus"): they go once more to the Teams window that holds focus, which
  // is kept for the next keys until it fails.
  let keyWindow: string | null = null;
  const press = async (keys: string): Promise<AgentDesktopResult> => {
    if (keyWindow) {
      const result = await exec("press", [keys, `--window-id=${keyWindow}`, HEADED_FLAG], KEY_MS);
      if (result.ok || stopped()) return result;
      keyWindow = null;
    }
    const result = await exec("press", [keys, ...where, HEADED_FLAG], KEY_MS);
    if (result.ok || stopped() || !NO_KEYBOARD.test(result.message ?? "")) return result;
    const listed = await exec("list-windows", [...where], READ_MS);
    const rows = listed.ok ? windowRowsSchema.safeParse(listed.data) : null;
    const windows = rows?.success ? rows.data.filter((row) => row !== null) : [];
    const focused = windows.find((row) => row.is_focused)?.id ?? null;
    debugLog.info("computer", "teams-recipe", { step: "key-window", ok: focused !== null, windows: windows.length });
    if (!focused || stopped()) return result;
    keyWindow = focused;
    return exec("press", [keys, `--window-id=${focused}`, HEADED_FLAG], KEY_MS);
  };
  if (stopped()) return { kind: "stopped" };

  // The user's own chat: the chat list's row marked "(You)" gives the name to search for ("Chat Vedant Bhopatrao (You) You: …").
  if (self) {
    const rows = await logged("self-row", okResult)(exec("find", [...where, "--role=treeitem", "--name=(You)", "--limit=5", `--timeout-ms=${LOOK_MS}`], LOOK_MS + 6000));
    if (stopped()) return { kind: "stopped" };
    const own = (rows.ok ? findMatches(rows.data) : []).map((match) => ownName(match.name ?? "")).find((name) => name !== null);
    if (!own) return fallback("Bee could not find your own chat (the one marked (You)) in Teams' chat list, so it typed no message.");
    message = { ...asked, name: own };
    first = "you";
  }

  // 2. Teams' search box, then the name with real keys. On Windows a key reaches Teams only while an element in it holds the
  // keyboard (else "no verified keyboard focus"), so Bee puts the cursor in the search box itself and types there; when it cannot,
  // it puts the cursor in the message box and presses ctrl+e (cmd+e); else ctrl+e alone. Then the box must hold the name: keys
  // that missed it move through the chat list instead (Down and Return then open the chat at the top, often the user's own).
  const keys = keyPresses(message.name);
  let searchBox: string | null = null;
  const typeName = async (): Promise<AgentDesktopResult> => {
    if (!keys || keys.length > NAME_KEYS_MAX) return (await pasteText(exec, { text: message.name, platform, scope: where })).result;
    for (const [index, key] of keys.entries()) {
      if (stopped()) return { ok: false, code: "ABORTED" };
      const result = await press(key);
      if (result.ok) continue;
      // Keys refused at the first one, with the search box known: type the name into the box itself instead.
      if (index === 0 && searchBox && NO_KEYBOARD.test(result.message ?? "") && !stopped()) {
        return logged("type-name", okResult)(exec("type", [searchBox, HEADED_FLAG, STDIN_FLAG], TYPE_MS, message.name));
      }
      return result;
    }
    return { ok: true, data: null };
  };
  // Teams' search box is a text field or a combobox, named like "Search".
  const searchFields = async (): Promise<Match[]> => {
    const found: Match[] = [];
    for (const role of ["textfield", "combobox"]) {
      const fields = await exec("find", [...where, `--role=${role}`, "--limit=15", `--timeout-ms=${LOOK_MS}`], LOOK_MS + 6000);
      if (fields.ok) found.push(...findMatches(fields.data).filter((match) => SEARCH_NAME.test(match.name ?? "")));
    }
    return found;
  };
  const editable = (fields: readonly Match[]) => fields.find((field) => field.ref_id && REF_PATTERN.test(field.ref_id) && !field.states?.includes("readonly"))?.ref_id ?? null;
  searchBox = editable(await logged("find-search", (found: Match[]) => found.length > 0)(searchFields()));
  if (stopped()) return { kind: "stopped" };
  const inSearch = searchBox ? (await logged("focus-search", okResult)(exec("focus", [searchBox, HEADED_FLAG], KEY_MS))).ok : false;
  if (stopped()) return { kind: "stopped" };
  if (inSearch) await press(modKey(platform, "a"));
  else {
    // Something in Teams must hold the keyboard for ctrl+e: the message box, when Bee can find it.
    const boxes = await exec("find", [...where, "--role=textfield", "--limit=15", `--timeout-ms=${LOOK_MS}`], LOOK_MS + 6000);
    const compose = boxes.ok ? composeRef(findMatches(boxes.data)) : null;
    if (compose && !stopped()) await logged("focus-compose", okResult)(exec("focus", [compose, HEADED_FLAG], KEY_MS));
    if (stopped()) return { kind: "stopped" };
    let search = await logged("search", okResult)(press(modKey(platform, "e")));
    // Just after Teams opens, agent-desktop can miss its process for a moment: once more.
    if (!search.ok && search.code === "APP_NOT_FOUND" && !stopped()) {
      await pause(pauses.search);
      search = await logged("search", okResult)(press(modKey(platform, "e")));
    }
    if (stopped()) return { kind: "stopped" };
    if (!search.ok) return fallback("Bee could not put the cursor in Teams' search box or open it with the keyboard.");
    await pause(pauses.search);
  }
  // A box holds the name when its text has it, or when it has the keyboard (Teams may not report the text). A miss only when no box
  // holds it and some box said what it holds or that it lacks the keyboard. No box, or nothing reported: Bee cannot tell, and
  // step 4 still checks the chat.
  const hasName = (field: Match) => (typeof field.value === "string" && fold(field.value).includes(fold(message.name))) || field.states?.includes("focused") === true;
  const missed = (fields: readonly Match[]) => !fields.some(hasName) && fields.some((field) => typeof field.value === "string" || field.states !== undefined);
  const typed = await logged("name", okResult)(typeName());
  if (stopped()) return { kind: "stopped" };
  if (!typed.ok) return fallback("Bee opened Teams' search but could not type the name to search for.");
  let searched = await logged("search-box", (found: Match[]) => !missed(found))(searchFields());
  if (stopped()) return { kind: "stopped" };
  const target = missed(searched) ? searched.find((field) => field.ref_id && !field.states?.includes("readonly"))?.ref_id : undefined;
  if (target) {
    // The keys missed the box: put the cursor in it (a click when Teams refuses focus), select what it holds, type again.
    let into = await logged("focus-search", okResult)(exec("focus", [target, HEADED_FLAG], KEY_MS));
    if (!into.ok && !stopped()) into = await logged("click-search", okResult)(exec("click", [target, HEADED_FLAG], KEY_MS));
    const again = into.ok && !stopped() && (await press(modKey(platform, "a"))).ok ? await logged("name-again", okResult)(typeName()) : into;
    if (stopped()) return { kind: "stopped" };
    if (again.ok) searched = await logged("search-box", (found: Match[]) => !missed(found))(searchFields());
    if (stopped()) return { kind: "stopped" };
  }
  if (missed(searched)) return fallback("Bee typed the name, but Teams' search box did not show it, so Bee opened no chat.");
  done.push(`Bee typed "${message.name}" in Teams' search.`);
  await pause(pauses.results);
  if (stopped()) return { kind: "stopped" };

  // 3. The result that names the person, by its place in the list (keys only). Two people match: Bee asks for the full name. No
  // result it can read: the first, as before. Step 4 checks the chat either way.
  const results = await logged("results", okResult)(exec("find", [...where, "--role=option", "--limit=20", `--timeout-ms=${LOOK_MS}`], LOOK_MS + 6000));
  if (stopped()) return { kind: "stopped" };
  // Search suggestions sit in a dropdown list; an open chat's messages can be options too ("George Dowling, is it merged?").
  const options = results.ok ? findMatches(results.data) : [];
  const inDropdown = options.filter((match) => match.path?.some((part) => /^listbox\b/i.test(part)));
  const pick = pickResult((inDropdown.length > 0 ? inDropdown : options).map((match) => match.name ?? ""), message.name);
  if (pick === "several") return { kind: "failed", line: `More than one person or chat in Teams matches "${message.name}". Say the full name. Nothing was sent.` };
  const downs = (pick ?? 0) + 1;
  for (const key of [...Array.from({ length: downs }, () => "down"), "return"]) {
    const result = await logged(key, okResult)(press(key));
    if (stopped()) return { kind: "stopped" };
    if (!result.ok) return fallback("Bee could not pick the search result.");
  }
  done.push(pick === null ? "It pressed Down and Return to open the first result." : `It pressed Down ${downs === 1 ? "once" : `${downs} times`} and Return to open the result that names ${message.name}.`);
  // The search popup closed with the chat opening: keys go to Teams' process again.
  keyWindow = null;
  await pause(pauses.open);
  if (stopped()) return { kind: "stopped" };

  // 4. The right chat is open: the chat list's selected row, the window's title or a heading names the person. Else nothing is written.
  const verified = await logged("verify", (value: boolean) => value)(chatOpen(exec, where, message.name));
  if (stopped()) return { kind: "stopped" };
  if (!verified) return fallback(`Bee could not confirm the chat with ${message.name} opened, so it typed no message.`);
  done.push(`The chat with ${message.name} is open.`);
  if (asked.openOnly && asked.read) {
    deps.onStep?.("Reading the chat…");
    // Teams labels each message with its author, text and time; only listitems outside the chat list and search are messages.
    const items = await logged("read-chat", okResult)(exec("find", [...where, "--role=listitem", `--limit=${CHAT_FIND_MAX}`, `--timeout-ms=${LOOK_MS}`], LOOK_MS + 6000));
    if (stopped()) return { kind: "stopped" };
    const messages = items.ok ? chatMessages(findMatches(items.data)) : [];
    debugLog.info("computer", "teams-recipe", { step: "messages", ok: messages.length > 0, count: messages.length });
    return { kind: "opened", line: `Read the chat with ${self ? "yourself" : message.name}.`, messages };
  }
  if (asked.openOnly) return { kind: "opened", line: `The chat with ${self ? "yourself" : message.name} is open. Read it with a snapshot of Teams.` };

  // 5. The message box, empty (or showing only its placeholder): a draft of the user's own is never touched.
  deps.onStep?.("Writing the message…");
  const fields = await logged("find-box", okResult)(exec("find", [...where, "--role=textfield", "--limit=15", `--timeout-ms=${LOOK_MS}`], LOOK_MS + 6000));
  if (stopped()) return { kind: "stopped" };
  const box = fields.ok ? composeRef(findMatches(fields.data)) : null;
  if (!box) return fallback("Bee could not find the message box in that chat.");
  const read = async () => {
    const result = await exec("get", [box, "--property=value"], READ_MS);
    return result.ok ? fieldValue(result.data) : null;
  };
  const placeholderOf = (held: string) => /^type a (?:new )?(?:message|reply)/i.test(squash(held));
  const empty = (held: string | null) => held !== null && (squash(held) === "" || placeholderOf(held));
  const before = await read();
  if (stopped()) return { kind: "stopped" };
  if (before !== null && !empty(before)) return { kind: "failed", line: `The chat with ${first} already has a draft in the message box, so Bee left it alone. Nothing was sent.` };
  const focused = await logged("focus-box", okResult)(exec("focus", [box, HEADED_FLAG], KEY_MS));
  if (stopped()) return { kind: "stopped" };
  if (!focused.ok) return fallback("Bee found the message box but could not put the cursor in it.");

  // 6. Paste, read back; once with real keys if the paste did not take. Only exact text goes on.
  const holds = (held: string | null) => held !== null && squash(held) === squash(message.text);
  const pasted = await logged("paste", (value: PasteOutcome) => value.result.ok)(pasteText(exec, { text: message.text, platform, scope: where }));
  if (stopped()) return { kind: "stopped" };
  let held = await read();
  if (stopped()) return { kind: "stopped" };
  if (held === null) {
    // Teams did not say what the box holds: Bee cannot check the text, so it never sends it.
    debugLog.info("computer", "teams-recipe", { step: "read-back", ok: false, unread: true });
    return pasted.result.ok
      ? { kind: "drafted", line: `Bee pasted the message into the chat with ${first} but could not read it back, so it did not send it.` }
      : { kind: "failed", line: "Bee could not write the message in Teams, so nothing was sent." };
  }
  if (!holds(held)) {
    // Only Bee's own text can be in the box now (it was empty): clear it, then type once.
    if (!empty(held)) await exec("clear", [box], KEY_MS);
    const retyped = await logged("type", okResult)(exec("type", [box, HEADED_FLAG, STDIN_FLAG], TYPE_MS, message.text));
    if (stopped()) return { kind: "stopped" };
    held = retyped.ok ? await read() : held;
    if (stopped()) return { kind: "stopped" };
    if (!holds(held)) {
      if (held !== null && !empty(held)) await exec("clear", [box], KEY_MS);
      return { kind: "failed", line: "Bee could not write the message in Teams, so nothing was sent." };
    }
  }
  if (pasted.restored === false) debugLog.info("computer", "teams-recipe", { step: "clipboard-restore", ok: false });
  if (!message.send) return { kind: "drafted", line: `Drafted the message to ${first} in Teams. Not sent.` };

  // 7. The user's Confirm, then Return, then the box must be empty.
  deps.onStep?.(CONFIRM_LABEL);
  const request: ConfirmRequest = { kind: "send", question: "Send this?", detail: `To ${self ? "your own chat" : shortName(message.name, 30)} in Teams — “${shortName(message.text, 70)}”` };
  debugLog.info("computer", "teams-recipe-confirm", { chars: message.text.length });
  const confirmed = await control.paused(() => awaitAnswer((signal) => deps.confirm(request, signal), control.signal, deps.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS));
  debugLog.info("computer", "teams-recipe", { step: "confirm", ok: confirmed });
  if (stopped()) return { kind: "stopped" };
  if (!confirmed) return { kind: "drafted", line: "Drafted, not sent." };
  deps.onStep?.(`Sending to ${first}…`);
  // Tapping Confirm put the keyboard in Bee's island: the cursor goes back into the message box before Return.
  await logged("refocus-box", okResult)(exec("focus", [box, HEADED_FLAG], KEY_MS));
  if (stopped()) return { kind: "stopped" };
  const sent = await logged("send", okResult)(press("return"));
  if (!sent.ok) return { kind: "failed", line: `Bee could not press Enter in Teams. The message is still in the box, not sent.` };
  // Once Return went out the run must not stop before it checks: the check runs even after a Stop.
  if (pauses.sent > 0) await exec("wait", [String(pauses.sent)], pauses.sent + 5000, undefined, true);
  const after = await exec("get", [box, "--property=value"], READ_MS, undefined, true);
  const left = after.ok ? fieldValue(after.data) : null;
  debugLog.info("computer", "teams-recipe", { step: "sent-check", ok: left !== null && empty(left), ms: msSince(started) });
  if (left === null) return { kind: "sent", line: `Pressed Enter to send to ${first}; Bee could not check that it went.` };
  if (!empty(left)) return { kind: "failed", line: "Bee pressed Enter, but the message is still in the box, so it may not have been sent." };
  deps.onEffect?.("send");
  return { kind: "sent", line: `Sent to ${self ? "your own chat" : message.name}.` };
}

/** How many listitems one read asks agent-desktop for, how many messages it keeps (the newest), and how long each may be. */
const CHAT_FIND_MAX = 200;
export const CHAT_MESSAGES_MAX = 20;
export const CHAT_MESSAGE_MAX = 400;

/**
 * The open chat's messages from find's listitems: in order (oldest first), the newest CHAT_MESSAGES_MAX, each as Teams labels it
 * (author, text, time) on one line. Rows inside the chat list (a tree), search suggestions (a listbox) or a menu are not messages.
 */
export function chatMessages(matches: readonly { name?: string | null; path?: string[] | undefined }[]): string[] {
  const messages = matches
    .filter((match) => !match.path?.some((part) => /^(?:tree|treeitem|listbox|menu|menubar)\b/i.test(part)))
    .map((match) => squash(match.name ?? ""))
    .filter((text) => text !== "")
    .map((text) => (text.length > CHAT_MESSAGE_MAX ? `${text.slice(0, CHAT_MESSAGE_MAX - 1)}…` : text));
  return messages.slice(-CHAT_MESSAGES_MAX);
}

/**
 * The chat with this name is open. When the chat list says which row is selected, that row decides, whatever the title says: the
 * title can lag behind the open chat. Else Teams' window title names it, or a heading in the window (the chat's header) does.
 */
async function chatOpen(exec: Exec, where: readonly string[], name: string): Promise<boolean> {
  const rows = await exec("find", [...where, "--role=treeitem", "--limit=60", `--timeout-ms=${LOOK_MS}`], LOOK_MS + 6000);
  const selected = rows.ok ? findMatches(rows.data).filter((match) => match.states?.includes("selected")) : [];
  if (selected.length > 0) return selected.some((match) => namesChat(match.name ?? "", name));
  const windows = await exec("list-windows", [...where], READ_MS);
  const parsed = windows.ok ? windowsSchema.safeParse(windows.data) : null;
  const titles = parsed?.success ? parsed.data.map((row) => row?.title ?? "") : [];
  if (titles.some((title) => namesChat(title, name))) return true;
  const headings = await exec("find", [...where, "--role=heading", "--limit=15", `--timeout-ms=${LOOK_MS}`], LOOK_MS + 6000);
  return headings.ok && findMatches(headings.data).some((match) => namesChat(match.name ?? "", name));
}
