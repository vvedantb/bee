import type { IrreversibleKind } from "./computer-control";

// "Ask before sending or deleting" (Settings, on by default): which computer-use actions pause for the user's Confirm in the
// island. Only an action that commits something asks: sending a message, email or post, deleting, buying or paying, and
// submitting a form. Ordinary clicks do not: looking, navigating, switching tabs or views, opening menus and apps, typing a
// draft, and buttons such as Continue, Next or OK that commit nothing. A control asks when its own name, the labels around it,
// a message box beside it, or a checkout or a dialog that names a commit says it commits; being somewhere in Slack, Gmail or
// Amazon is not enough. The answer comes from the accessibility tree Bee read (core/computer-tools.ts formatSnapshot keeps
// where each ref sits); the AI's stated effect can add a Confirm, never remove one. Pure: core/computer-tools.ts asks first.

/** What the AI says an action does. Anything but none needs a confirm, whatever the element is called. */
export const EFFECTS = ["none", "send", "delete", "buy", "submit"] as const;
export type Effect = (typeof EFFECTS)[number];

/** Where an element sat in the snapshot that showed it. */
export type TreeContext = {
  /** The app and window title the snapshot read ("Google Chrome Inbox - Gmail"). */
  app: string;
  /** The containers it sits in, nearest first (group "Message @sam", toolbar, dialog "Delete message?"). */
  ancestors: readonly Element[];
  /** Short labels of its nearest neighbours, nearest first. Never what a text field holds. */
  nearby: readonly string[];
  /** A text field beside it (a sibling, or a cousin in the same container), when there is one. */
  field: Element | null;
};

/** An element as the latest snapshot or find named it. */
export type Element = {
  role: string;
  name: string;
  description?: string;
  value?: string;
  /** Absent: Bee never saw where it sits (a find match), so only its own name can make it ask. */
  context?: TreeContext;
};

export type GateAction = {
  /** The agent-desktop command: click, type, press… Only click, select, type, set-value and press can need a confirm. */
  command: string;
  effect?: Effect;
  /** The element acted on. Null or absent: unknown (a ref the run never saw does not run). */
  target?: Element | null;
  /** press: the keys ("return", "cmd+enter"). */
  keys?: string;
  /** type, set-value, select: the text written or the option chosen. */
  text?: string;
  /** Where keyboard focus is, as far as Bee knows: the field written last, or what a snapshot showed focused. Null: unknown. */
  lastField?: Element | null;
};

// Words that commit something. Whole words, so "Posts", "Sender", "Orders" and "Deleted items" do not count. Deleting comes
// first, so "Delete post" reads as a delete.
const NAMED: readonly [IrreversibleKind, RegExp][] = [
  ["delete", /\b(?:delete|remove|trash|move to (?:the )?(?:trash|bin)|discard|erase|purge|wipe|unsend|retract|don['’]?t save|empty (?:the )?(?:trash|bin)|uninstall|clear (?:chat|history|conversation))\b|🗑|🚮/iu],
  ["submit", /\bcancel (?:my |your |the )?(?:subscription|order|membership|booking|plan|account)\b/i],
  ["send", /\b(?:send|re-?send|send now|post|re-?post|publish|tweet|re-?tweet|reply|reply all|comment)\b|[➤➢➣✈📤📨📩]/iu],
  ["buy", /\b(?:buy|purchase|pay|order|place (?:your )?order|order now|check ?out|subscribe|upgrade|renew|book now|donate|transfer|place bid)\b/i],
  ["submit", /\b(?:submit|confirm|sign up|register|unsubscribe)\b/i],
];

// A name that clearly commits nothing. Only a whole name counts ("Close", not "Close account"); a commit word beats it.
const SAFE_NAME = new RegExp(
  "^(?:" +
    [
      "compose(?: (?:a )?(?:new )?(?:message|email|mail|post))?",
      "new(?: (?:message|email|mail|chat|conversation|post|thread|draft|note|tab|window|group|meeting))?",
      "start (?:a )?(?:new )?(?:chat|conversation|message|thread)",
      "close(?: (?:tab|window|dialog|panel|pane|sidebar|thread|menu|popup|search|preview))?",
      "save (?:&|and) close", "cancel", "dismiss", "not now", "back", "go back", "undo", "redo",
      "minimi[sz]e", "maximi[sz]e", "full ?screen", "exit full ?screen", "pop ?out",
      "emojis?", "(?:insert|add) (?:an )?emoji", "emoji picker",
      "attach(?:ment)?", "attach (?:a )?files?", "add (?:a )?(?:files?|attachment)",
      "format(?:ting)?(?: options)?", "(?:show|hide) formatting", "bold", "italic", "underline", "strikethrough",
      "bulleted list", "numbered list", "mention(?: someone)?",
      "more", "more options", "more actions", "options", "menu", "search", "expand", "collapse", "show more", "show less",
      "scroll to bottom", "jump to (?:present|latest|bottom|new messages)",
    ].join("|") +
    ")$",
  "i",
);

// A name that says nothing about what the control does: "button", "OK", "Go". An empty or symbol-only name counts too.
const GENERIC_NAME = /^(?:button|btn|icon|icon button|image|img|graphic|svg|unlabell?ed|untitled|action|click|tap|ok|okay|yes|done|continue|go|apply|proceed)$/i;

// Shops, and the checkout words that make an unlabelled control there a purchase. Being in a shop alone is not enough.
const SHOPPING = /\b(?:amazon|ebay|etsy|shop|shopping|store|cart|basket|checkout|check out|order|payment|paypal|deliveroo|uber ?eats|just ?eat|doordash|instacart|tesco|ocado|sainsbury'?s|asda|argos|ikea|aliexpress|temu|shein|airbnb|booking\.com|ticketmaster)\b/i;
const CHECKOUT = /\b(?:check ?out|cart|basket|bag|pay|payment|order|buy|purchase)\b/i;

// A message composer by its name: the box itself ("Message @sam", "Type a message") or the area around it.
const COMPOSER_FIELD = /^(?:message|reply|write|type a|send a message|chat with|comment|add a comment)\b|\b(?:compose|composer|message body|message text|draft)\b/i;
const COMPOSER_AREA = /\b(?:compose|composer|composing|draft|message (?:body|box|field|input|bar|area|text|composer|editor)|chat (?:box|input|bar)|text ?(?:box|area|input)|reply (?:box|area|field)|write a|type a|send a message|new (?:message|email|mail|post)|rich ?text editor)\b|^(?:message|reply)\s+(?:[@#]|to\b)/i;

// A search, address or filter box: Return there navigates.
const NAV_FIELD = /\b(?:search|address|url|location|find|filter|go ?to|jump to|switcher|omnibox|look ?up)\b/i;
const NAV_ROLES = /^(?:search ?field|search ?box|combo ?box)$/i;
const TEXT_ROLES = /^(?:textfield|textarea|textbox|text ?field|text ?area|text ?box|searchfield|search ?field|search ?box|combobox|combo ?box|edit|editable ?text|entry|securetextfield|secure ?text ?field|password ?field)$/i;
/** Roles whose name is a title, not a control's label. */
export const WINDOW_ROLES = /^(?:window|application|app|document|webarea|web ?area|desktop)$/i;
const DIALOG_ROLES = /^(?:dialog|alertdialog|alert|sheet|popover|modal)$/i;
// A container label longer than this is content (a message, a subject line), not a control's label. Dialogs always count.
export const LABEL_MAX = 40;
// How far up the tree a commit word around an element still counts.
const CONTEXT_DEPTH = 3;

const ENTER = new Set(["return", "enter", "numpadenter", "kpenter"]);
const DELETE_KEYS = new Set(["delete", "backspace", "forwarddelete", "del"]);
const MODIFIERS = new Set(["cmd", "command", "meta", "ctrl", "control", "alt", "option", "shift", "win", "super"]);
// Send shortcuts outside a Return: Outlook (Windows) and Apple Mail.
const SEND_KEYS = new Set(["alt+s", "option+s", "cmd+shift+d", "command+shift+d"]);
// Keys after which focus may be somewhere else: Return, Tab, Escape, function keys.
const MOVES_FOCUS = /^(?:return|enter|numpadenter|kpenter|tab|escape|esc|f\d{1,2})$/;

/** A name as words: "sendButton" and "ic_delete" read as "send Button" and "ic delete". */
const words = (text: string) => text.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_+/g, " ");
/** A name without a shortcut hint or trailing dots: "Bold (⌘B)" → "Bold". */
const plain = (name: string) =>
  words(name)
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/[\s.…:]+$/, "")
    .replace(/\s+/g, " ")
    .trim();

/** A text field or text area (search and combo boxes too). Clicking one only puts the cursor there. */
export const isTextEntry = (element: Element | null | undefined): boolean => !!element && TEXT_ROLES.test(element.role.trim());

/** A search, address or filter box, where Return navigates. A message box is never one, whatever its channel is called. */
export function isNavField(field: Element | null | undefined): boolean {
  if (!field || !isTextEntry(field) || COMPOSER_FIELD.test(plain(field.name))) return false;
  return NAV_ROLES.test(field.role.trim()) || NAV_FIELD.test(field.name);
}

// A terminal or console inside an app Bee may use (VS Code's terminal, a browser's console): typing there runs commands.
const SHELL_ELEMENT = /\b(?:terminal|console|command prompt|powershell|pwsh|bash|zsh|fish|shell|cmd\.exe|repl)\b/i;

/** An element where typed text could run as a command. Computer use never clicks, focuses or types into one. */
export function shellElement(element: Element | null | undefined): boolean {
  return !!element && SHELL_ELEMENT.test(`${element.role} ${element.name || element.value || ""}`);
}

/** The kind a name reads as, or null. */
export function namedKind(name: string): IrreversibleKind | null {
  const text = words(name);
  return NAMED.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

/** No useful name: empty, symbols or emoji only ("➤", "→"), one character, or generic ("button", "OK"). */
export function unlabelled(element: Element): boolean {
  const name = plain(element.name);
  return !/[\p{L}\p{N}]/u.test(name) || name.length <= 1 || GENERIC_NAME.test(name) || name.toLowerCase() === element.role.toLowerCase();
}

const ancestorText = (ancestor: Element) => `${ancestor.name} ${ancestor.description ?? ""}`;

/** A commit word around an element: the parent's label, the neighbours', then the containers above. */
function contextKind(context: TreeContext): IrreversibleKind | null {
  const near = context.ancestors.slice(0, CONTEXT_DEPTH).filter((ancestor) => !WINDOW_ROLES.test(ancestor.role));
  const labels = (ancestors: readonly Element[]) =>
    ancestors.filter((ancestor) => DIALOG_ROLES.test(ancestor.role) || ancestor.name.length <= LABEL_MAX).map(ancestorText);
  for (const label of [...labels(near.slice(0, 1)), ...context.nearby, ...labels(near.slice(1))]) {
    const kind = namedKind(label);
    if (kind) return kind;
  }
  return null;
}

/** Inside or beside a message box or any text field other than a search or address box. */
function inComposer(context: TreeContext): boolean {
  if (context.field && !isNavField(context.field)) return true;
  return context.ancestors.some((ancestor) => !WINDOW_ROLES.test(ancestor.role) && (isTextEntry(ancestor) || COMPOSER_AREA.test(plain(ancestor.name))));
}

/**
 * What an unlabelled control may do where it sits: buy in a shop's cart or checkout, or what a dialog's label names ("Delete
 * this file?"). An icon in a plain dialog or on a product page does not ask; one beside a message box is a send (inComposer).
 */
function placeKind(context: TreeContext): IrreversibleKind | null {
  const places = [context.app, ...context.ancestors.map(ancestorText)];
  if (places.some((place) => SHOPPING.test(place)) && [...places, ...context.nearby].some((place) => CHECKOUT.test(place))) return "buy";
  for (const dialog of context.ancestors.filter((ancestor) => DIALOG_ROLES.test(ancestor.role))) {
    const kind = namedKind(ancestorText(dialog));
    if (kind) return kind;
  }
  return null;
}

/**
 * What clicking (or choosing in) an element commits, from the tree alone: its own name, description and value; then, unless
 * its own name clearly commits nothing (Compose, Close, Emoji), a commit word next to or around it, a message box or text
 * field beside it, and for a control with no useful name, a checkout or a dialog that names a commit. Clicking into a text
 * field never asks, and nor does an unlabelled control Bee never saw in place (a find match).
 */
export function elementKind(target: Element | null | undefined): IrreversibleKind | null {
  if (!target || isTextEntry(target)) return null;
  const own = namedKind([target.name, target.description, target.value, target.role].filter(Boolean).join(" | "));
  if (own) return own;
  if (SAFE_NAME.test(plain(target.name))) return null;
  const { context } = target;
  if (!context) return null;
  return contextKind(context) ?? (inComposer(context) ? "send" : null) ?? (unlabelled(target) ? placeKind(context) : null);
}

/**
 * What a key press commits. Return (with any modifier) sends in a message box or text field, and presses a focused control,
 * which asks only when that control would (a search or address box navigates). Space presses a focused control. With focus
 * unknown, Return and Space do not ask. Delete keys delete outside a text field.
 */
function keysKind(keys: string, focus: Element | null | undefined): IrreversibleKind | null {
  const parts = keys.toLowerCase().split("+");
  const base = parts.at(-1) ?? "";
  const modified = parts.slice(0, -1).some((part) => MODIFIERS.has(part));
  if (SEND_KEYS.has(parts.join("+"))) return "send";
  const field = isTextEntry(focus);
  if (ENTER.has(base)) {
    if (!focus || isNavField(focus)) return null;
    if (field || COMPOSER_FIELD.test(plain(focus.name))) return "send";
    return elementKind(focus);
  }
  if (base === "space" && !modified) return field || !focus ? null : elementKind(focus);
  if (DELETE_KEYS.has(base)) return modified || !field ? "delete" : null;
  return null;
}

/**
 * What the action commits, or null when it is safe to run without asking: the AI's stated effect when it names one, else what
 * the tree says. effect "none" never clears a tree hit. type with a line break presses Return, so it counts like Return.
 * set-value writes the value directly (no key events), so a draft with line breaks is still a draft.
 */
export function irreversibleKind(action: GateAction): IrreversibleKind | null {
  if (action.effect && action.effect !== "none") return action.effect;
  switch (action.command) {
    case "click":
      return elementKind(action.target);
    case "select":
      return namedKind(action.text ?? "") ?? elementKind(action.target);
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

/** False when a press may move keyboard focus (Return, Tab, Escape, a shortcut), so where focus is becomes unknown. */
export function keepsFocus(keys: string): boolean {
  const parts = keys.toLowerCase().split("+");
  return parts.slice(0, -1).every((part) => part === "shift") && !MOVES_FOCUS.test(parts.at(-1) ?? "");
}

/** Focus after a click: in the text field clicked; else still in a message box written to; else unknown. */
export function focusAfterClick(last: Element | null, clicked: Element | null | undefined): Element | null {
  if (clicked && isTextEntry(clicked)) return clicked;
  return last && isTextEntry(last) && !isNavField(last) ? last : null;
}

/** The context of an element found inside a container Bee saw: that container and the ones around it. */
export function insideOf(container: Element | null | undefined, max = 8): TreeContext | undefined {
  const outer = container?.context;
  if (!container || !outer) return undefined;
  const self: Element = { role: container.role, name: container.name, ...(container.description ? { description: container.description } : {}) };
  return { app: outer.app, ancestors: [self, ...outer.ancestors].slice(0, max), nearby: [], field: null };
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
