import type { ModelMessage } from "ai";
import type { IrreversibleKind } from "./computer-control";

// A last check on what Bee tells the user it did. The prompts already say "never claim a send without proof", yet logs show lines
// like "Sent hi to Zuzanna." from a run that never typed or sent anything, and "No meetings today." after the calendar failed to
// open. This reads the run's own tool calls and results (and the kinds the confirm gate counted, core/computer-gate.ts) and, when
// a line claims a send, delete, purchase or form submit that nothing in THIS run proves, or claims an empty calendar with no
// successful calendar read behind it, swaps it for a cautious line. Only a positive claim is checked: "Not sent yet" and "Could
// not send" pass as written. Proof is always of that kind: an open_app, a web search or any other tool that succeeded never
// proves a send. Pure: no Electron, no model call.

export type ClaimKind = IrreversibleKind;

// Words that say an irreversible thing happened. Past tense and whole words only, so "send", "ready to send" and "sender" never
// count. Plain "ordered" and "registered" are left out: "ordered the list", "registered the change" are not purchases.
const CLAIMS: readonly (readonly [ClaimKind, RegExp])[] = [
  ["delete", /\b(?:deleted|removed|trashed|erased|discarded|purged)\b/i],
  ["send", /\b(?:sent|re-?sent|delivered|posted|replied|messaged|e-?mailed|tweeted|published|dm['’]?d)\b/i],
  ["buy", /\b(?:purchased|bought|paid|placed (?:the |an |your |that )?order|completed (?:the )?(?:checkout|purchase))\b/i],
  ["submit", /\b(?:submitted|signed up)\b/i],
];
// A clause that denies, doubts or puts off the action: "not sent yet", "could not verify it was sent", "nothing was deleted".
const NEGATED =
  /\b(?:not|never|no|nothing|none|cannot|unable|failed|fail|without|yet|unsent|whether|if|would|will|ready to|about to|could not|did not|was not|is not|has not|have not)\b|n['’]t\b/i;
// Where a line splits into clauses, so "Sent hi, but could not close the tab" still claims the send.
const CLAUSE = /[,;.!?:]+|\s[—–-]\s|\b(?:but|and|then|so|although|though|while)\b/i;

/** Every irreversible action a line says happened, in order: "Deleted the draft and sent the email." → delete, send. */
export function claimedEffects(line: string): ClaimKind[] {
  const found: ClaimKind[] = [];
  for (const clause of line.split(CLAUSE)) {
    const text = clause.trim();
    if (!text || NEGATED.test(text)) continue;
    for (const [kind, pattern] of CLAIMS) if (pattern.test(text) && !found.includes(kind)) found.push(kind);
  }
  return found;
}

/** The first irreversible action a line says happened, or null: "Sent hi to Zuzanna." → send; "Typed hi; not sent yet." → null. */
export function claimedEffect(line: string): ClaimKind | null {
  return claimedEffects(line)[0] ?? null;
}

// Claims that a calendar is empty. Narrow on purpose: only the "no meetings" kind of answer the logs showed after a failed open.
const ABSENCE =
  /\b(?:no|zero) (?:more )?(?:meetings?|events?|appointments?|calls?)\b|\b(?:calendar|diary|schedule|day) (?:is|looks) (?:empty|clear|free)\b|\bnothing (?:is )?(?:on|in) (?:the |your )?(?:calendar|diary|schedule)\b/i;

/** The line says the calendar is empty or has no meetings. */
export function claimsEmptyCalendar(line: string): boolean {
  return ABSENCE.test(line);
}

/** What this run's tool calls and results prove. */
export type RunEvidence = {
  /**
   * Irreversible kinds this run proved, and only these: an action marked with that effect came back Done, the confirm gate counted
   * a Done action as that kind, or a connector tool whose own name says that action succeeded (connectorEffect).
   */
  proven: Set<ClaimKind>;
  /** Text Bee put in a field this run (set_value or type_text that succeeded), the newest last. */
  typed: string[];
  /** Tool calls made, results that succeeded, and results that were errors. For the log: none of them proves a claim. */
  toolCalls: number;
  okResults: number;
  failedResults: number;
  /** Results that succeeded from a tool that reads something (a snapshot, find, read, a connector or web search): not an action. */
  okReads: number;
  /** Tool calls aimed at a calendar: a calendar app opened, focused or read, or a calendar connector tool. */
  calendarCalls: number;
  /** Of those, reads that succeeded: a calendar's content was seen. A web search or another app's snapshot never counts. */
  calendarReads: number;
};

// Computer and desktop tools that act or list rather than read content: their success proves nothing about what a page says.
const NOT_READS = new Set([
  "click", "type_text", "set_value", "focus", "select_option", "set_state", "scroll", "press_key", "act", "open_app", "focus_window", "open_url", "close_app",
  "wait", "list_apps", "list_windows", "use_computer", "memory_write", "append_note",
]);
// Tools that bring an app forward: what Bee reads next with no app named is that app's window.
const OPENS = new Set(["open_app", "focus_window"]);
// Bee's own tools that read something other than an app or a connector: never a calendar.
const NOT_CALENDAR = new Set(["web_search", "memory_read", "list_dir", "search_files", "read_file", "list_apps", "list_windows"]);
const TYPES = new Set(["set_value", "type_text"]);
const KINDS = new Set<string>(["send", "delete", "buy", "submit"]);

// A calendar app by name: "Calendar", "gnome-calendar", "org.gnome.Calendar", "Fantastical", "BusyCal". Outlook is left out:
// its window may be mail, so an Outlook read counts only when the window title shows a calendar (CALENDAR_WINDOW).
const CALENDAR_APP = /calendar|kalender|fantastical|busycal|\bagenda\b|\bdiary\b/i;
// A snapshot or find result from a calendar window: agent-desktop names the window first ('window "Calendar - Outlook"').
const CALENDAR_WINDOW = /\bwindow\s+"[^"\n]*\b(?:calendar|agenda|schedule)\b/i;
// A connector tool that reads a calendar, by the words in its name: outlook__list_calendar_events, gcal__list_events.
const CALENDAR_TOOL = /(?:^|_)(?:calendars?|events?|schedules?|agenda|appointments?|availability|freebusy)(?:_|$)/;

// A connector tool (Bee names them `{server}__{tool}`, core/mcp.ts) whose own name says it sends, deletes, buys or submits:
// slack__chat_post_message, gmail__send_email, outlook__delete_event, shop__place_order, forms__submit_response. A name that also
// reads (get, list, search…) never counts: get_post, list_sent_messages. Bee's built-in tools never match: they have no "__".
const CONNECTOR_EFFECTS: readonly (readonly [ClaimKind, RegExp])[] = [
  ["send", /^(?:send|post|reply|forward|publish|tweet|dm|email|mail|message)$/],
  ["delete", /^(?:delete|remove|trash|erase|purge|discard|destroy)$/],
  ["buy", /^(?:buy|purchase|checkout|pay)$/],
  ["submit", /^(?:submit|signup|register)$/],
];
const READ_WORDS = /^(?:get|list|search|read|find|fetch|query|lookup|view|show|describe|count|check|preview|draft|drafts|schedule|scheduled)$/;

/** The action a connector tool's name says it does ("slack__chat_post_message" → send), or null: Bee's own tools, reads, others. */
export function connectorEffect(toolName: string): ClaimKind | null {
  const split = toolName.indexOf("__");
  if (split <= 0) return null;
  const words = toolName
    .slice(split + 2)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.length === 0 || words.some((word) => READ_WORDS.test(word))) return null;
  // "place_order", "create_order": a purchase only with a verb that places it.
  if (words.includes("order") && words.some((word) => word === "place" || word === "create" || word === "submit")) return "buy";
  for (const [kind, verb] of CONNECTOR_EFFECTS) if (words.some((word) => verb.test(word))) return kind;
  return null;
}

/** A connector tool's name says it reads a calendar ("gcal__list_events"). */
const isCalendarTool = (toolName: string) => toolName.includes("__") && CALENDAR_TOOL.test(toolName.slice(toolName.indexOf("__") + 2).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase());

type Part = { type: string; [key: string]: unknown };
const parts = (message: ModelMessage): Part[] => (typeof message.content === "string" ? [{ type: "text", text: message.content }] : (message.content as unknown as Part[]));

/** A tool result as text: the text value, or the JSON of anything else. */
function resultText(output: unknown): string {
  const value = output as { type?: string; value?: unknown } | undefined;
  if (value && typeof value === "object" && (value.type === "text" || value.type === "error-text") && typeof value.value === "string") return value.value;
  if (value && typeof value === "object" && value.type === "content" && Array.isArray(value.value)) {
    return value.value.map((item: Part) => (item.type === "text" ? String(item.text ?? "") : "")).join("\n");
  }
  try {
    return JSON.stringify(value?.value ?? value ?? "");
  } catch {
    return "";
  }
}

const isDone = (text: string) => /^(?:Using [^\n]{1,120}? for [^\n]{1,120}?\. )?Done\b/.test(text.trim());
/**
 * What computer-tools adds to a send that came back Done when its check found the text still in the message box: the action ran,
 * but nothing shows the message left. Such a result proves no send.
 */
export const NOT_SENT_MARK = "so it may not have been sent";
const isError = (text: string, output: unknown) => /^\s*Error\b/.test(text) || (output as { type?: string } | undefined)?.type?.startsWith("error") === true;
// A connector's own failure inside a result that came back as text: {"ok":false}, {"isError":true}, {"error":"…"}.
const CONNECTOR_FAILED = /"(?:ok|success)"\s*:\s*false|"isError"\s*:\s*true|"error"\s*:\s*(?:"|\{)/;

/** The evidence in one run's messages (the AI's tool calls and their results), plus the kinds the confirm gate counted. */
export function runEvidence(messages: readonly ModelMessage[], gateKinds: Iterable<ClaimKind> = []): RunEvidence {
  const evidence: RunEvidence = { proven: new Set(gateKinds), typed: [], toolCalls: 0, okResults: 0, failedResults: 0, okReads: 0, calendarCalls: 0, calendarReads: 0 };
  const calls = new Map<string, { name: string; input: Record<string, unknown>; calendar: boolean }>();
  // The app Bee last opened, focused or read by name: a read that names no app reads that one.
  let current = "";
  // The app a desktop or computer tool works on: open_app and close_app take a name, the others an app.
  const appOf = (name: string, input: Record<string, unknown>) => {
    const app = name === "open_app" || name === "close_app" ? input.name : input.app;
    return typeof app === "string" ? app : "";
  };
  for (const message of messages) {
    for (const part of parts(message)) {
      // The AI's own tool calls, and a provider's (web search), which come back inside the assistant message.
      if (part.type === "tool-call" && message.role === "assistant") {
        evidence.toolCalls += 1;
        const name = String(part.toolName);
        const input = part.input && typeof part.input === "object" ? (part.input as Record<string, unknown>) : {};
        const app = appOf(name, input);
        const calendar = !NOT_CALENDAR.has(name) && (isCalendarTool(name) || CALENDAR_APP.test(app) || (!app && !NOT_READS.has(name) && CALENDAR_APP.test(current)));
        if (calendar) evidence.calendarCalls += 1;
        calls.set(String(part.toolCallId), { name, input, calendar });
      }
      if (part.type !== "tool-result" || (message.role !== "tool" && message.role !== "assistant")) continue;
      const call = calls.get(String(part.toolCallId));
      const name = call?.name ?? String(part.toolName);
      const text = resultText(part.output);
      if (isError(text, part.output) || /\bBee stopped this task\b/.test(text)) {
        evidence.failedResults += 1;
        continue;
      }
      evidence.okResults += 1;
      const input = call?.input ?? {};
      if (OPENS.has(name) || (!NOT_READS.has(name) && appOf(name, input))) current = appOf(name, input);
      if (!NOT_READS.has(name)) {
        evidence.okReads += 1;
        // Seen only by a read of a calendar: its app, a calendar connector, or a window whose title says calendar.
        if (!NOT_CALENDAR.has(name) && (call?.calendar === true || CALENDAR_WINDOW.test(text))) evidence.calendarReads += 1;
      }
      // A connector whose own name says it sends, deletes, buys or submits, and that did not report a failure.
      const effect = connectorEffect(name);
      if (effect && !CONNECTOR_FAILED.test(text)) evidence.proven.add(effect);
      if (name === "act" && Array.isArray(input.actions)) {
        // "1. click: Done." per action that ran, in order.
        for (const line of text.split("\n")) {
          const match = /^(\d+)\. \w+: (.*)$/.exec(line.trim());
          const item = match ? (input.actions[Number(match[1]) - 1] as Record<string, unknown> | undefined) : undefined;
          if (!item || !isDone(match?.[2] ?? "")) continue;
          if (KINDS.has(String(item.effect)) && !(match?.[2] ?? "").includes(NOT_SENT_MARK)) evidence.proven.add(item.effect as ClaimKind);
          if (TYPES.has(String(item.do))) evidence.typed.push(String(item.value ?? item.text ?? ""));
        }
        continue;
      }
      if (!isDone(text)) continue;
      if (KINDS.has(String(input.effect)) && !text.includes(NOT_SENT_MARK)) evidence.proven.add(input.effect as ClaimKind);
      if (TYPES.has(name)) evidence.typed.push(String(input.value ?? input.text ?? ""));
    }
  }
  return evidence;
}

/** Kinds Bee's own text in these messages already told the user happened (an earlier turn's "Sent hi to Sam."). */
export function claimsShown(messages: readonly ModelMessage[]): Set<ClaimKind> {
  const kinds = new Set<ClaimKind>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of parts(message)) if (part.type === "text" && typeof part.text === "string") for (const kind of claimedEffects(part.text)) kinds.add(kind);
  }
  return kinds;
}

/**
 * Evidence for an answer that may talk about earlier turns ("Yes, Bee sent it at 3 pm."): this turn's tool calls and results,
 * plus what earlier turns proved or already told the user. Earlier claims count because the history keeps the line the user
 * saw, never an unproven claim Bee replaced (replaceLastText).
 */
export function answerEvidence(turn: readonly ModelMessage[], history: readonly ModelMessage[]): RunEvidence {
  const evidence = runEvidence(turn);
  for (const kind of runEvidence(history).proven) evidence.proven.add(kind);
  for (const kind of claimsShown(history)) evidence.proven.add(kind);
  return evidence;
}

/**
 * The messages with the AI's last text replaced by the line the user was shown, its tool calls kept, so the history never holds a
 * claim Bee did not stand behind. With no assistant text, the line is added at the end.
 */
export function replaceLastText(messages: readonly ModelMessage[], line: string): ModelMessage[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const content = parts(message);
    if (!content.some((part) => part.type === "text")) continue;
    const kept = content.filter((part) => part.type !== "text");
    const next = { ...message, content: [...kept, { type: "text", text: line }] } as ModelMessage;
    return [...messages.slice(0, index), next, ...messages.slice(index + 1)];
  }
  return [...messages, { role: "assistant", content: [{ type: "text", text: line }] }];
}

const TYPED_SHOWN_MAX = 30;

/** The cautious line for a claim nothing proves. */
export function unprovenLine(kind: ClaimKind, typed: readonly string[] = []): string {
  const last = (typed.at(-1) ?? "").replace(/\s+/g, " ").trim();
  switch (kind) {
    case "send":
      if (!last) return "Bee could not confirm anything was sent.";
      return last.length <= TYPED_SHOWN_MAX ? `Typed "${last}"; Bee could not confirm it was sent.` : "Typed the message; Bee could not confirm it was sent.";
    case "delete":
      return "Bee could not confirm anything was deleted.";
    case "buy":
      return "Bee could not confirm the purchase went through.";
    case "submit":
      return "Bee could not confirm the form was submitted.";
  }
}

/** The plain line for an action this run proved: `Sent "hi".`, "Deleted it.". */
export function provenLine(kind: ClaimKind, typed: readonly string[] = []): string {
  const last = (typed.at(-1) ?? "").replace(/\s+/g, " ").trim();
  switch (kind) {
    case "send":
      return last && last.length <= TYPED_SHOWN_MAX ? `Sent "${last}".` : "Sent the message.";
    case "delete":
      return "Deleted it.";
    case "buy":
      return "Placed the order.";
    case "submit":
      return "Submitted the form.";
  }
}

/** The line for an empty-calendar claim with no successful read behind it. */
export const UNSEEN_CALENDAR_LINE = "Bee could not read the calendar, so it cannot say whether you have meetings.";

export type GuardedLine = { line: string; rewritten: boolean; reason: ClaimKind | "unseen-calendar" | null };

/**
 * The line to show. A claimed send, delete, purchase or submit stays only when evidence.proven has that kind: never because some
 * other tool succeeded (an open_app, a list, a web search). For an answer about earlier turns, answerEvidence adds what those
 * turns proved or showed. A line that claims a proven kind and an unproven one keeps the proven one in plain words, then the
 * cautious line for the other: a proven send is never shown as unconfirmed. An empty-calendar claim after tools ran stays only
 * when a calendar read succeeded. With no calendar tool tried, any read that succeeded will do, as before: the answer may come
 * from the meeting brief.
 */
export function guardLine(line: string, evidence: RunEvidence): GuardedLine {
  const claims = claimedEffects(line);
  const unproven = claims.find((claim) => !evidence.proven.has(claim));
  if (unproven) {
    const kept = claims.filter((claim) => evidence.proven.has(claim)).map((claim) => provenLine(claim, evidence.typed));
    return { line: [...kept, unprovenLine(unproven, evidence.typed)].join(" "), rewritten: true, reason: unproven };
  }
  if (claimsEmptyCalendar(line) && unseenCalendar(evidence)) return { line: UNSEEN_CALENDAR_LINE, rewritten: true, reason: "unseen-calendar" };
  return { line, rewritten: false, reason: null };
}

// A line that doubts an action: "Bee could not confirm the send went through", "couldn't verify it was sent".
const UNSURE = /\b(?:could not|couldn['’]t|cannot|can['’]t|unable to)\s+(?:confirm|verify|tell|check)\b/i;
// Words that say the action failed, was refused or did not happen: such a line is never upgraded, whatever the run proved.
const FAILED =
  /\b(?:fail(?:ed|s|ure)?|error|declined|cancel(?:led|ed)?|stopped|refused|blocked|did not|didn['’]t|was not|wasn['’]t|has not|hasn['’]t|not (?:sent|deleted|bought|submitted|placed)|unsent|still (?:holds|has|shows|there|in))\b/i;
const DOUBTED: readonly (readonly [ClaimKind, RegExp])[] = [
  ["send", /\b(?:sent|send|sending|delivered|posted)\b/i],
  ["delete", /\b(?:deleted|delete|deleting|deletion|removed)\b/i],
  ["buy", /\b(?:purchased?|bought|order|payment|paid)\b/i],
  ["submit", /\b(?:submitted|submit|submission)\b/i],
];

/**
 * The one action a cautious line doubts ("Bee could not confirm the send went through." → send), or null: no doubt, a word
 * that says it failed, or doubts about more than one kind.
 */
export function doubtedEffect(line: string): ClaimKind | null {
  if (!UNSURE.test(line) || FAILED.test(line)) return null;
  const kinds = DOUBTED.filter(([, pattern]) => pattern.test(line)).map(([kind]) => kind);
  return kinds.length === 1 ? (kinds[0] ?? null) : null;
}

/**
 * A line that undersells what the run proved: it doubts a send, delete, purchase or submit that the confirm gate counted as done
 * (proven: the kinds core/computer-tools.ts reported through onEffect, never contradicted by its check of the message box). Then
 * the plain claim (provenLine) instead. Any other line stays as written. Only for computer use, where proven comes from this run.
 */
export function upgradeLine(line: string, proven: ReadonlySet<ClaimKind>, typed: readonly string[] = []): { line: string; upgraded: boolean; kind: ClaimKind | null } {
  const kind = doubtedEffect(line);
  if (!kind || !proven.has(kind) || claimedEffects(line).length > 0) return { line, upgraded: false, kind: null };
  return { line: provenLine(kind, typed), upgraded: true, kind };
}

// Bee's own tool names, and plain words for each, for a line the user reads. Single English words (click, find, read) stay.
const TOOL_WORDS: Record<string, string> = {
  open_app: "opening the app",
  focus_window: "bringing the window forward",
  open_url: "opening the page",
  close_app: "closing the app",
  list_apps: "the list of open apps",
  list_windows: "the list of windows",
  type_text: "typing",
  set_value: "filling in the field",
  press_key: "the key press",
  select_option: "choosing the option",
  set_state: "changing the setting",
  use_computer: "working on screen",
  memory_read: "Bee's memory",
  memory_write: "Bee's memory",
  web_search: "a web search",
  list_dir: "the folder list",
  search_files: "a file search",
  read_file: "reading the file",
  append_note: "the notes",
};
const TOOL_NAME = new RegExp(`\`?\\b(${Object.keys(TOOL_WORDS).join("|")})\\b\`?`, "g");
// A connector tool as Bee names it (`{server}__{tool}`, core/mcp.ts): "slack__chat_post_message" → "the slack connector".
const CONNECTOR_TOOL = /`?\b([a-z0-9][a-z0-9-]*)__[a-z0-9_]+\b`?/gi;
// agent-desktop's own codes and Bee's runner codes, as computer use sees them ("APP_NOT_FOUND"), and a ref ("@s8f3k2p9:e12").
// Only these: any other capitalised name with underscores (an environment variable in an answer) is the user's.
const ERROR_CODE =
  /\b(?:APP_NOT_FOUND|APP_UNRESPONSIVE|ACTION_FAILED|ACTION_NOT_SUPPORTED|AMBIGUOUS_TARGET|ELEMENT_NOT_FOUND|WINDOW_NOT_FOUND|SNAPSHOT_NOT_FOUND|STALE_REF|INVALID_ARGS|POLICY_DENIED|PERM_DENIED|PLATFORM_NOT_SUPPORTED|TIMEOUT_LOCAL|SPAWN_FAILED|BAD_OUTPUT)\b/g;
const REF = /@s[a-z0-9]+:e\d+/gi;

/**
 * A line for the user without Bee's internals: tool names ("open_app"), connector tool names, agent-desktop codes and refs, in
 * plain words instead ("…never appeared after opening the app"). Anything else stays as written.
 */
export function withoutToolNames(line: string): string {
  const plain = line
    .replace(TOOL_NAME, (_match, name: string) => TOOL_WORDS[name] ?? name)
    .replace(CONNECTOR_TOOL, (_match, server: string) => `the ${server} connector`)
    .replace(ERROR_CODE, (code) => code.toLowerCase().replace(/_/g, " "))
    .replace(REF, "that element");
  if (plain === line) return line;
  // A line that began with a name now begins with plain words: "open_app failed" → "Opening the app failed".
  const startsWithName = /^\s*`?(?:[a-z]+_[a-z_]+|[a-z0-9-]+__|[A-Z]+_[A-Z_]+\b|@s[a-z0-9]+:)/i.test(line);
  const text = plain.replace(/[ \t]+/g, " ").trim();
  return startsWithName && text.length > 0 ? text[0]!.toUpperCase() + text.slice(1) : text;
}

/** Tools ran, and none read the calendar: a calendar tool was tried and no calendar read succeeded, or nothing was read at all. */
function unseenCalendar(evidence: RunEvidence): boolean {
  if (evidence.toolCalls === 0 || evidence.calendarReads > 0) return false;
  return evidence.calendarCalls > 0 || evidence.okReads === 0;
}
