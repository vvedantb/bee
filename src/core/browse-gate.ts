import { awaitAnswer, CONFIRM_TIMEOUT_MS, type IrreversibleKind } from "./computer-control";
import { confirmQuestion, namedKind, shortName } from "./computer-gate";
import type { ConfirmRequest } from "./computer-tools";
import { debugLog } from "./debug-log";

// The Confirm gate for OpenCode Browse's execute tool (core/browse.ts), which runs Playwright code in the user's real browser. Bee
// cannot see the page, only the code, so this reads the code: a click, Enter or form submit whose selector, name or field says it
// sends, posts, buys, submits or deletes waits for the user's Confirm in the island, with the same prompt as computer use
// (core/computer-gate.ts). Conservative: a false alarm costs a tap, a miss may send a message. Text the code types into a field
// never counts, so a search for "delete" is not a delete. Pure but for the log line.

export type BrowseRisk = { kind: IrreversibleKind; label: string };

// A key press that is Return, with or without modifiers ("Enter", "Control+Enter", "Meta+Enter": Gmail's send shortcut).
const ENTER_KEY = /\.(?:press|down)\s*\(\s*(?:(?:'[^']*'|"[^"]*"|`[^`]*`)\s*,\s*)?['"`](?:[A-Za-z]+\+)*(?:Enter|NumpadEnter)['"`]/;
// Typing a line break presses Return: keyboard.type("hi\n"), locator.pressSequentially('hi\n').
const TYPED_ENTER = /\.(?:type|pressSequentially)\s*\((?:[^()]|\([^()]*\))*\\[nr]/;
// Clicks, taps and a page's own WebMCP tools: what they do is in the selector or name.
const CLICK = /\.(?:click|dblclick|tap|dispatchEvent)\s*\(|\bwebmcp\s*\.\s*call\s*\(/;
const FORM_SUBMIT = /\.(?:submit|requestSubmit)\s*\(/;
// A request that changes something on a site, past its page: page.request.post(…), fetch(url, { method: "DELETE" }).
const WRITE_REQUEST = /\brequest\s*\.\s*(post|put|patch|delete)\s*\(|\bmethod\s*:\s*['"`](post|put|patch|delete)['"`]/i;
const DIALOG_ACCEPT = /\bdialog\b[\s\S]*\.accept\s*\(/;
// Where keyboard focus goes: a field filled, typed into, clicked or focused.
const FOCUSES = /\.(?:fill|type|pressSequentially|click|focus|check|selectText|tap)\s*\(/;
const KEYBOARD = /\bkeyboard\s*\.\s*(?:press|down|type)\s*\(/;

// A field where Return sends: a message, chat, comment, reply, post or compose box. A plain text area or editor counts too, to be
// safe, unless it is a search box (Google's is a textarea).
const COMPOSER = /\b(?:message|messages|msg|chat|comment|comments|reply|replies|compose|composer|draft|post|tweet|caption|dm)\b/i;
const TEXT_AREA = /\b(?:textarea|contenteditable|body|editor|prompt|write|status)\b/i;
// A search, address or filter box: a submit there only searches.
const SEARCH = /\b(?:search|query|q|find|filter|address|url|omnibox|lookup|look up|go to|jump to)\b/i;
// Receivers that are not a locator someone named.
const PLAIN_RECEIVERS = new Set(["page", "frame", "keyboard", "mouse", "context", "browser", "el", "element", "e", "node", "this", "document", "window"]);
// Roles a getByRole names first: never the label to show.
const ROLE_WORD = /^(?:button|link|textbox|menuitem|menuitemcheckbox|tab|checkbox|radio|combobox|option|dialog|alertdialog|listitem|row|cell|gridcell|heading|img|switch|searchbox|form|main|navigation|region|article)$/i;

// A typed value (fill, type, pressSequentially, insertText) is masked: what is typed is the user's text, never the control's name.
const TYPED_VALUE = /(\.(?:fill|type|pressSequentially|insertText)\s*\((?:\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)\s*,)?)\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`|[A-Za-z_$][\w$.]*)/g;
const LITERAL = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`|\/((?:[^/\\\n*]|\\.)(?:[^/\\\n]|\\.)*)\/[dgimsuy]*/g;

/** Code as words: "sendButton", "#submit_order-1" and "aria-label" read as "send Button", "submit order 1", "aria label". */
function words(text: string): string {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/[_\-#.[\]=(){}:,<>*^$\\|/+?!;~@&%"`]/g, " ")
    .replace(/\s+/g, " ");
}

/** A statement without the values it types. */
const masked = (statement: string) => statement.replace(TYPED_VALUE, "$1 VALUE");

/** Skips a string or template literal starting at `start`; returns the index after it. */
function skipString(code: string, start: number): number {
  const quote = code[start];
  for (let index = start + 1; index < code.length; index++) {
    const char = code[index];
    if (char === "\\") index++;
    else if (char === quote) return index + 1;
    else if (char === "\n" && quote !== "`") return index;
  }
  return code.length;
}

/** Skips a regex literal starting at `start` (its class brackets too); returns the index after its flags. */
function skipRegex(code: string, start: number): number {
  let inClass = false;
  for (let index = start + 1; index < code.length; index++) {
    const char = code[index];
    if (char === "\\") index++;
    else if (char === "\n") return index;
    else if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) {
      let end = index + 1;
      while (end < code.length && /[a-z]/i.test(code[end] ?? "")) end++;
      return end;
    }
  }
  return code.length;
}

/** A slash here starts a regex, not a division: after an operator, an opening bracket, a comma or the start. */
function regexAllowed(code: string, index: number): boolean {
  const before = code.slice(0, index).trimEnd();
  return before.length === 0 || /[(,=:[!&|?{};]$/.test(before) || /\breturn$/.test(before);
}

/**
 * The code's statements, in order: split at ; { } and at line ends outside brackets, unless the next line carries on the chain
 * (".click()") or the line ends mid-expression. Strings, regexes and comments never split. A locator chain over several lines and
 * a getByRole with its options on their own lines stay one statement.
 */
export function statements(code: string): string[] {
  const out: string[] = [];
  let start = 0;
  let depth = 0;
  const cut = (end: number) => {
    const text = code.slice(start, end).trim();
    if (text) out.push(text);
    start = end + 1;
  };
  let index = 0;
  while (index < code.length) {
    const char = code[index];
    const next = code[index + 1];
    if (char === "/" && next === "/") {
      const end = code.indexOf("\n", index);
      index = end < 0 ? code.length : end;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = code.indexOf("*/", index + 2);
      index = end < 0 ? code.length : end + 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      index = skipString(code, index);
      continue;
    }
    if (char === "/" && regexAllowed(code, index)) {
      index = skipRegex(code, index);
      continue;
    }
    if (char === "(" || char === "[") depth++;
    else if ((char === ")" || char === "]") && depth > 0) depth--;
    else if (depth === 0 && (char === ";" || char === "{" || char === "}")) cut(index);
    else if (depth === 0 && char === "\n") {
      const carriesOn = /^\s*[.)\]?:,+\-*/|&]/.test(code.slice(index + 1)) || /[=+\-*/,.&|?:(]\s*$/.test(code.slice(start, index));
      if (!carriesOn) cut(index);
    }
    index++;
  }
  cut(code.length);
  return out;
}

/** The text of each string and regex literal in a statement, as a person reads it. */
function literals(statement: string): string[] {
  return [...statement.matchAll(LITERAL)].map((match) => (match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").replace(/\\(.)/g, "$1").replace(/[\^$]/g, "").replace(/\s+/g, " ").trim()).filter(Boolean);
}

/** The statement that set a variable used as an action's receiver (`const send = page.getByRole(…)`), nearest first. */
function receiverSetup(statement: string, earlier: readonly string[]): string {
  const receiver = /([A-Za-z_$][\w$]*)\s*\.\s*(?:click|dblclick|tap|dispatchEvent|press|down|type|pressSequentially|fill|focus|submit|requestSubmit)\s*\(/.exec(statement)?.[1];
  if (!receiver || PLAIN_RECEIVERS.has(receiver)) return "";
  const name = receiver.replace(/\$/g, "\\$");
  const assigns = new RegExp(`(?:^|[\\s(,])(?:const|let|var)?\\s*${name}\\s*=(?!=)|\\b(?:const|let|var)\\s+${name}\\s+(?:of|in)\\b`);
  return [...earlier].reverse().find((item) => assigns.test(item)) ?? "";
}

/** The kind a control's text names, or null. A submit in a search form only searches. */
function controlKind(context: string): IrreversibleKind | null {
  const text = words(context);
  const kind = namedKind(text);
  return kind === "submit" && SEARCH.test(text) ? null : kind;
}

/** What Return commits in a field (null: unknown focus, which counts as a send). */
function enterKind(field: string | null): IrreversibleKind | null {
  if (field === null) return "send";
  const named = controlKind(field);
  if (named) return named;
  const text = words(field);
  return COMPOSER.test(text) || (TEXT_AREA.test(text) && !SEARCH.test(text)) ? "send" : null;
}

// A label inside a CSS or Playwright selector: [aria-label^="Send"], text=Send, :has-text("Post").
const SELECTOR_LABEL = /\[(?:aria-label|title|name|value|placeholder)[\^*$~|]?=["']?([^"'\]]+)|\btext=["']?([^"']+)|:has-text\(["']([^"']+)/i;

/** A literal as the user reads it: a selector's label rather than the whole selector. */
const display = (literal: string) => {
  const match = SELECTOR_LABEL.exec(literal);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? literal).trim();
};

/** The literal that names the control for the Confirm prompt: one that says what it commits, else the first that is not a role. */
function controlName(context: string, risky: (text: string) => boolean): string | null {
  const found = literals(context);
  const name = found.find(risky) ?? found.find((text) => !ROLE_WORD.test(text) && text !== "VALUE");
  return name ? shortName(display(name)) : null;
}

const quoted = (name: string | null, fallback: string, verb: string) => (name ? `${verb} “${name}”` : fallback);

/**
 * What a browse `execute` script commits, or null when it may run without asking: the first click, tap, page tool call, Return,
 * form submit, accepted dialog or write request (POST, PUT, PATCH, DELETE) whose code says it sends, posts, buys, submits or
 * deletes. Return asks in a message, comment, reply or compose box, or when the script never shows where focus is. The label is
 * what the Confirm prompt shows ("Click “Send”"): only the control's own name from the code, never page content.
 */
export function browseRisk(code: string): BrowseRisk | null {
  const parts = statements(code);
  let lastField: string | null = null;
  for (const [index, raw] of parts.entries()) {
    const earlier = parts.slice(0, index);
    const context = masked(`${receiverSetup(raw, earlier)}\n${raw}`);
    if (DIALOG_ACCEPT.test(raw)) return { kind: "submit", label: "Accept a page dialog" };
    const write = WRITE_REQUEST.exec(raw);
    if (write) {
      const method = (write[1] ?? write[2] ?? "post").toUpperCase();
      return { kind: method === "DELETE" ? "delete" : "submit", label: `Send a ${method} request` };
    }
    if (FORM_SUBMIT.test(raw) && !SEARCH.test(words(context))) return { kind: "submit", label: "Submit a form" };
    if (CLICK.test(raw)) {
      const kind = controlKind(context);
      if (kind) return { kind, label: quoted(controlName(context, (text) => controlKind(text) !== null), "Click a button", /\bwebmcp\b/.test(raw) ? "Run" : "Click") };
    }
    if (ENTER_KEY.test(raw) || TYPED_ENTER.test(raw)) {
      const field = KEYBOARD.test(raw) ? lastField : context;
      const kind = enterKind(field);
      if (kind) {
        const name = field ? controlName(field, (text) => enterKind(text) !== null) : null;
        return { kind, label: quoted(name, "Press Enter", "Press Enter in") };
      }
    }
    if (FOCUSES.test(raw) && !KEYBOARD.test(raw)) lastField = context;
  }
  return null;
}

export type BrowseDecision = { allow: true; confirmed: IrreversibleKind | null } | { allow: false; message: string };

export const BROWSE_DECLINED = "The user declined this in Bee's Confirm prompt, so it did not run. Do not try it another way; say it was not done.";
export const BROWSE_NO_CONFIRM =
  "Bee cannot ask the user to confirm a send, post, purchase, submit or delete here, so it did not run. Tell the user to ask Bee directly to do it.";

/**
 * Whether a browse `execute` may run. A risky script (browseRisk) waits for the island's Confirm (the same prompt as computer
 * use, 60 s at most); without a way to ask (a background task), it is refused. Logged with the label only.
 */
export async function browseDecision(args: {
  code: string;
  confirm?: ((request: ConfirmRequest, signal: AbortSignal) => Promise<boolean>) | undefined;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<BrowseDecision> {
  const risk = browseRisk(args.code);
  if (!risk) return { allow: true, confirmed: null };
  const confirm = args.confirm;
  if (!confirm) {
    debugLog.warn("ai", "browse-gate", { kind: risk.kind, label: risk.label, decision: "no-confirm" });
    return { allow: false, message: BROWSE_NO_CONFIRM };
  }
  const request: ConfirmRequest = { kind: risk.kind, question: confirmQuestion(risk.kind), detail: `${risk.label} in your browser` };
  debugLog.info("ai", "browse-gate", { kind: risk.kind, label: risk.label, decision: "asking" });
  const confirmed = await awaitAnswer((signal) => confirm(request, signal), args.signal, args.timeoutMs ?? CONFIRM_TIMEOUT_MS);
  debugLog.info("ai", "browse-gate", { kind: risk.kind, label: risk.label, decision: confirmed ? "confirmed" : "declined" });
  return confirmed ? { allow: true, confirmed: risk.kind } : { allow: false, message: BROWSE_DECLINED };
}
