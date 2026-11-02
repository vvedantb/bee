import type { IrreversibleKind } from "./computer-control";

// "Ask before sending or deleting" (Settings, on by default): which computer-use actions pause for the user's Confirm in the
// island. Sending a message or email, deleting, buying and submitting a form do. Looking, navigating, clicking, typing a draft,
// and opening or closing apps and tabs do not. Pure: core/computer-tools.ts asks before it runs the action.

/** What the AI says an action does. Anything but none needs a confirm, whatever the element is called. */
export const EFFECTS = ["none", "send", "delete", "buy", "submit"] as const;
export type Effect = (typeof EFFECTS)[number];

/** An element as the latest snapshot or find named it. */
export type Element = { role: string; name: string };

export type GateAction = {
  /** The agent-desktop command: click, type, press… Only click, select, type, set-value and press can need a confirm. */
  command: string;
  effect?: Effect;
  /** The element acted on. Null or absent: unknown. */
  target?: Element | null;
  /** press: the keys ("return", "cmd+enter"). */
  keys?: string;
  /** type, set-value, select: the text written or the option chosen. */
  text?: string;
  /** The text field written last in this run. A search or address box makes Return a navigation. */
  lastField?: Element | null;
};

// Element names (and options) that commit something. Whole words, so "Posts", "Sender" and "Deleted items" do not count.
const NAMED: readonly [IrreversibleKind, RegExp][] = [
  ["send", /\b(?:send|re-?send|send now|post|publish|tweet)\b/i],
  ["delete", /\b(?:delete|remove|trash|move to (?:the )?(?:trash|bin)|discard|erase|don['’]?t save|empty (?:the )?(?:trash|bin)|uninstall)\b/i],
  ["buy", /\b(?:buy|purchase|pay|place (?:your )?order|order now|check ?out|subscribe|book now|donate|transfer)\b/i],
  ["submit", /\b(?:submit|confirm|sign up|register)\b/i],
];

// A search, address or filter box: Return there navigates.
const NAV_FIELD = /\b(?:search|address|url|location|find|filter|go ?to|jump to|switcher|omnibox|look ?up)\b/i;
const NAV_ROLES = new Set(["searchfield", "combobox"]);
const ENTER = new Set(["return", "enter", "numpadenter", "kpenter"]);
const DELETE_KEYS = new Set(["delete", "backspace", "forwarddelete", "del"]);
const MODIFIERS = new Set(["cmd", "command", "meta", "ctrl", "control", "alt", "option", "shift", "win", "super"]);

const isNavField = (field: Element | null | undefined) => !!field && (NAV_ROLES.has(field.role.toLowerCase()) || NAV_FIELD.test(field.name));

// A terminal or console inside an app Bee may use (VS Code's terminal, a browser's console): typing there runs commands.
const SHELL_ELEMENT = /\b(?:terminal|console|command prompt|powershell|pwsh|bash|zsh|fish|shell|cmd\.exe|repl)\b/i;

/** An element where typed text could run as a command. Computer use never clicks, focuses or types into one. */
export function shellElement(element: Element | null | undefined): boolean {
  return !!element && SHELL_ELEMENT.test(`${element.role} ${element.name}`);
}

/** The kind a name reads as, or null. */
export function namedKind(name: string): IrreversibleKind | null {
  return NAMED.find(([, pattern]) => pattern.test(name))?.[0] ?? null;
}

/** What a key press commits: Return sends or submits unless a search or address box was written last; Cmd+Delete deletes. */
function keysKind(keys: string, lastField: Element | null | undefined): IrreversibleKind | null {
  const parts = keys.toLowerCase().split("+");
  const base = parts.at(-1) ?? "";
  const modified = parts.slice(0, -1).some((part) => MODIFIERS.has(part));
  if (ENTER.has(base)) {
    if (isNavField(lastField)) return null;
    // Return after writing in a message box sends it; with nothing written this run, it may submit what is on screen.
    return lastField ? "send" : "submit";
  }
  if (DELETE_KEYS.has(base)) return modified || !lastField ? "delete" : null;
  return null;
}

/**
 * What the action commits, or null when it is safe to run without asking: the AI's stated effect first, then the element's
 * name, then the keys. type with a line break presses Return, so it counts like Return. set-value writes the value directly
 * (no key events), so a draft with line breaks is still a draft.
 */
export function irreversibleKind(action: GateAction): IrreversibleKind | null {
  if (action.effect && action.effect !== "none") return action.effect;
  switch (action.command) {
    case "click":
      return action.target ? namedKind(action.target.name) : null;
    case "select":
      return namedKind(action.text ?? "") ?? (action.target ? namedKind(action.target.name) : null);
    case "press":
      return keysKind(action.keys ?? "", action.lastField);
    case "type":
      return /[\r\n]/.test(action.text ?? "") && !isNavField(action.target) ? "send" : null;
    default:
      return null;
  }
}

/** With the setting on, the kind to confirm; with it off, never. */
export function needsConfirm(action: GateAction, askFirst: boolean): IrreversibleKind | null {
  return askFirst ? irreversibleKind(action) : null;
}

const QUESTION: Record<IrreversibleKind, string> = {
  send: "Send this?",
  delete: "Delete this?",
  buy: "Buy this?",
  submit: "Submit this?",
};

/** The Confirm prompt's question ("Send this?"). */
export const confirmQuestion = (kind: IrreversibleKind): string => QUESTION[kind];

const NAME_MAX = 40;
/** A name cut to fit one island line. */
export function shortName(name: string, max = NAME_MAX): string {
  const line = name.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** "Press Return", "Cmd+Shift+T". */
export function keysLabel(keys: string): string {
  return keys
    .split("+")
    .map((part) => (part.length <= 1 ? part.toUpperCase() : `${part[0]?.toUpperCase() ?? ""}${part.slice(1).toLowerCase()}`))
    .join("+");
}

/** The Confirm prompt's detail: what Bee is about to do, for example "Click “Send” in Discord". */
export function confirmDetail(action: GateAction, app: string | null): string {
  const target = action.target?.name ? `“${shortName(action.target.name)}”` : "the selected item";
  const where = app ? ` in ${shortName(app, 24)}` : "";
  switch (action.command) {
    case "press":
      return `Press ${keysLabel(action.keys ?? "")}${action.lastField?.name ? ` in “${shortName(action.lastField.name)}”` : where}`;
    case "type":
      return `Type and press Return in ${target}${where}`;
    case "select":
      return `Choose “${shortName(action.text ?? "")}”${where}`;
    case "set-value":
      return `Fill in ${target}${where}`;
    default:
      return `Click ${target}${where}`;
  }
}
