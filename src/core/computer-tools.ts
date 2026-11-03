import { tool } from "ai";
import { z } from "zod";
import {
  HEADED_FLAG, REF_PATTERN, parseApps, parseWindows, type AdBounds, type AgentDesktopFailure, type AgentDesktopResult, type ComputerRun, type ComputerUseCommand,
} from "./agent-desktop-envelope";
import { awaitAnswer, CONFIRM_TIMEOUT_MS, type ComputerPlatform, type IrreversibleKind, type RunControl } from "./computer-control";
import {
  EFFECTS, LABEL_MAX, WINDOW_ROLES, confirmDetail, confirmQuestion, focusAfterClick, insideOf, isNavField, isTextEntry, keepsFocus, keysLabel, needsConfirm,
  shellElement, shortName, type Effect, type Element, type GateAction, type TreeContext,
} from "./computer-gate";
import { APP_NAME_MAX, WINDOW_TITLE_MAX, appKey, isBlockedApp, type DesktopActionResult, type DesktopActions } from "./desktop-actions";
import { debugLog, errorData, msSince } from "./debug-log";
import type { LunaToolActivity } from "./luna";

// The AI's computer tools, for a direct request only ("Bee, send Sam a message in Discord"): never in a meeting tip turn. They
// read an app's accessibility tree and act on one element at a time through agent-desktop (main runs each command on its own
// runner with fixed argv and no shell; main/agent-desktop.ts assertComputerUse checks every one). Apps open, windows come forward
// and pages open through the desktop actions (core/desktop-actions.ts). Each call is one step of the run's budget
// (core/computer-control.ts); sending, deleting, buying and submitting wait for the user's Confirm first when the setting is on
// (core/computer-gate.ts, which reads where each ref sits in the tree, not just what the AI says). Terminals, script tools,
// system settings and Bee itself are never read or typed into. When an app's tree cannot be read (a Chromium or WebView2 app
// such as Teams that is still building it, or fails), click_at clicks a spot in a screenshot and type_text types where it put
// the cursor.

export type ConfirmRequest = { kind: IrreversibleKind; question: string; detail: string };

export type ComputerToolDeps = {
  run: ComputerRun;
  desktop: DesktopActions;
  control: RunControl;
  platform: ComputerPlatform;
  /** "Ask before sending or deleting", read per action so the switch applies at once. */
  askFirst: () => boolean;
  /** Shows the Confirm prompt in the island; resolves true for Confirm. signal aborts once the answer is settled. */
  confirm: (request: ConfirmRequest, signal: AbortSignal) => Promise<boolean>;
  /** The island's one short line for the step in progress ("Clicking Send…"). */
  onStep?: (label: string) => void;
  onActivity?: (activity: LunaToolActivity) => void;
  confirmTimeoutMs?: number;
};

/** The step line while a Confirm waits for the user. */
export const CONFIRM_LABEL = "Waiting for you to confirm…";
/** What a tool says once the run has stopped. The run's own line (core/computer-control.ts stopLine) is what the user sees. */
export const STOPPED = "Error: Bee stopped this task. Do not call any more tools.";

// Beyond the shells and script tools Bee never opens: apps whose controls change security, permissions or Bee itself.
const OFF_LIMITS = new Set(
  [
    "bee", "electron", "system settings", "system preferences", "systemsettings", "control panel", "settings",
    "windows security", "securityhealthui", "task manager", "taskmgr", "activity monitor", "keychain", "1password", "bitwarden",
    "lastpass", "dashlane", "keeper", "screen time",
  ].map((name) => name.toLowerCase()),
);
const OFF_LIMITS_MESSAGE = "Error: Bee does not use terminals, script tools, system settings, password managers or Bee itself.";

/** An app computer use never reads, types into or screenshots. */
export function offLimitsApp(name: string): boolean {
  return isBlockedApp(name) || OFF_LIMITS.has(appKey(name));
}

const SHELL_MESSAGE = "Error: Bee does not type into terminals or consoles.";

const SURFACES = ["window", "menu", "menubar", "sheet", "popover", "alert"] as const;
// Text in a snapshot line, and the whole snapshot, so a dense app cannot flood the context.
const NODE_TEXT = 80;
// What the confirm gate keeps about where each ref sits: containers above it, neighbours each side, a description or value.
const MAX_ANCESTORS = 8;
const NEIGHBOURS = 3;
const KEPT_TEXT = 200;
const SNAPSHOT_CHARS = 9000;
const MAX_NODES = 1500;
const MAX_DEPTH = 60;
const FIND_LIMIT = 15;
// agent-desktop's observation budget for snapshot and find, and the longer one for a second read. A cold Chromium or WebView2
// app (Teams, Slack, Discord) builds its web tree only once the first read asks, which takes 10 to 25 s, and a new process sees
// the grown tree: a thin first read, or one that failed where a retry is safe, is read again once with more time.
const LOOK_TIMEOUT_MS = 12_000;
const SETTLE_TIMEOUT_MS = 25_000;
// Bee's kill timer sits this far above agent-desktop's own budget: start-up, and a large tree's JSON.
const KILL_MARGIN_MS = 6000;
// A whole-window read is thin with fewer refs than THIN_REFS (a cold Chromium app shows little more than its title bar
// buttons), or when it ran out of budget (complete: false) with fewer than PARTIAL_REFS (a first read is about a thirteenth of
// the settled tree). The second read also goes deeper: Chromium nests its controls under long chains of unnamed groups.
const THIN_REFS = 4;
const PARTIAL_REFS = 20;
const DEEP_DEPTH = 25;
// Codes, and details.kind words, where a second read may succeed, when agent-desktop says a retry is safe (nothing was
// delivered).
const LOOK_AGAIN = new Set(["INTERNAL", "TIMEOUT", "APP_UNRESPONSIVE"]);
const LOOK_AGAIN_KIND = /renderer|activation|incomplete|settle/;
// get and is take no budget of their own: Bee's kill timer only.
const READ_MS = 15_000;
const ACT_MS = 12_000;
const WAIT_MAX_MS = 15_000;
// What has focus after a click at a point: a short search, never retried.
const FOCUS_TIMEOUT_MS = 6000;
// A screenshot as base64. Larger ones are refused rather than sent.
const SCREENSHOT_MAX_CHARS = 6_000_000;
// Text typed as key presses, one process each: kept short.
const KEYS_MAX = 300;

const HINTS: Record<string, string> = {
  STALE_REF: "the screen changed. Take a new snapshot and use its refs.",
  SNAPSHOT_NOT_FOUND: "the screen changed. Take a new snapshot and use its refs.",
  ELEMENT_NOT_FOUND: "the screen changed. Take a new snapshot and use its refs.",
  AMBIGUOUS_TARGET: "several windows or elements match. Pass window_id from list_windows, or narrow it with find.",
  APP_NOT_FOUND: "that app is not running, or has another name. Check list_apps, or open it with open_app.",
  WINDOW_NOT_FOUND: "no such window. Check list_windows.",
  ACTION_NOT_SUPPORTED: "that element cannot do this. Try another tool or element.",
  POLICY_DENIED: "this step needs real input. Set physical only if the step truly needs real keys or focus.",
  ACTION_FAILED: "it may still have happened. Look again before trying anything else. Never repeat a send or delete blindly.",
  APP_UNRESPONSIVE: "it may still have happened. Look again before trying anything else. Never repeat a send or delete blindly.",
  TIMEOUT: "it may still have happened. Look again before trying anything else.",
  TIMEOUT_LOCAL: "that took too long. Look again, or try a smaller region with root.",
  INVALID_ARGS: "check the ref and the arguments. Refs come only from the latest snapshot or find.",
  PLATFORM_NOT_SUPPORTED: "not available on this computer. Try another way.",
  PERM_DENIED: "Bee is not allowed to do that.",
  ABORTED: "Bee stopped this task.",
  INTERNAL:
    "agent-desktop hit an unexpected error in this app. Look again once. For a busy app take a skeleton snapshot, then root one region. If it keeps failing, take a screenshot and use click_at.",
  BAD_OUTPUT: "agent-desktop gave no answer Bee could read. Look again once. If it keeps failing, take a screenshot and use click_at.",
  SPAWN_FAILED: "Bee could not start its desktop helper. Stop and say so.",
  REFUSED: "Bee does not run that. Check the ref, app name, window id and other arguments.",
};
// Looking (snapshot, find, read, check_state, list_apps, list_windows) changes nothing, so a timeout or no answer means the
// app's tree is slow or broken, not that something may have happened.
const LOOK_HINTS: Record<string, string> = {
  TIMEOUT:
    "the app's tree did not finish in time. Take a skeleton snapshot, then root one region, or find by role. If the app just opened, wait and look again. If it keeps failing, take a screenshot and use click_at.",
  TIMEOUT_LOCAL: "the app's tree took too long. Take a skeleton snapshot, then root one region. If it keeps failing, take a screenshot and use click_at.",
  APP_UNRESPONSIVE: "the app did not answer. Wait, then look again. If it keeps failing, take a screenshot and use click_at.",
};
const MAY_HAVE_HAPPENED = "It may still have happened: look before trying again.";

/**
 * A failed command as the AI sees it: the code, what to do, and agent-desktop's own message when it gave one (cut short and with
 * names, titles and paths taken out: core/agent-desktop-envelope.ts safeMessage). look: an observation, which changes nothing.
 * An action agent-desktop does not call safe to retry may still have happened.
 */
export function errorLine(failure: string | AgentDesktopFailure, look = false): string {
  const { code, message, retry } = typeof failure === "string" ? { code: failure, message: undefined, retry: undefined } : failure;
  const hint = (look ? LOOK_HINTS[code] : undefined) ?? HINTS[code] ?? "that did not work. Look again before trying something else.";
  const unsafe = !look && retry !== undefined && retry !== "safe" && !hint.includes("may still have happened") ? ` ${MAY_HAVE_HAPPENED}` : "";
  return `Error ${code}: ${hint}${unsafe}${message ? ` Detail: ${message}` : ""}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const clip = (text: string, max = NODE_TEXT) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
const quoted = (text: string) => `"${clip(text).replace(/"/g, "'")}"`;

/** One element's line: role, name, value, ref, states, and how much a skeleton cut. */
function elementLine(node: Record<string, unknown>, depth: number): string | null {
  const role = str(node.role) || "element";
  const name = str(node.name);
  const value = str(node.value);
  const ref = str(node.ref_id);
  const states = Array.isArray(node.states) ? node.states.filter((state): state is string => typeof state === "string").slice(0, 6) : [];
  const inside = typeof node.children_count === "number" ? node.children_count : 0;
  if (!ref && !name.trim() && !value.trim() && inside === 0) return null;
  return [
    "  ".repeat(Math.min(depth, 20)),
    role,
    name.trim() ? ` ${quoted(name)}` : "",
    value.trim() && value !== name ? ` value=${quoted(value)}` : "",
    ref ? ` ${ref}` : "",
    states.length > 0 ? ` [${states.join(", ")}]` : "",
    inside > 0 ? ` (${inside} inside: snapshot it with root)` : "",
  ].join("");
}

/** A node's own labels. A text field's name never falls back to what it holds (a draft could read as "Search"). */
function elementOf(raw: Record<string, unknown>): Element {
  const role = str(raw.role);
  const description = clip(str(raw.description), KEPT_TEXT);
  const value = clip(str(raw.value), KEPT_TEXT);
  return {
    role,
    name: str(raw.name) || (isTextEntry({ role, name: "" }) ? "" : value) || description,
    ...(description ? { description } : {}),
    ...(value ? { value } : {}),
  };
}

/** A container as an ancestor: role, name and description only (never a value). */
const asAncestor = ({ role, name, description }: Element): Element => ({ role, name, ...(description ? { description } : {}) });
const childrenOf = (raw: Record<string, unknown>): unknown[] => (Array.isArray(raw.children) ? raw.children : []);
const focusedNode = (raw: Record<string, unknown>) => Array.isArray(raw.states) && raw.states.includes("focused") && !WINDOW_ROLES.test(str(raw.role));

type Place = { parent: Record<string, unknown> | null; grand: Record<string, unknown> | null; siblings: readonly unknown[]; index: number; ancestors: readonly Element[] };
type FoundField = { field: Element; branch: unknown; depth: number };

/**
 * A snapshot as compact text lines, one per element, indented by depth, capped in size. Each ref seen is remembered with its
 * role, name and where it sits (containers, neighbours, a text field beside it), so the confirm gate knows what a click would
 * press. within: the ref a root snapshot read, so its region keeps the containers above it. Returns the app the snapshot read,
 * when it says, and the element it shows focused. A node Bee cannot read is left out with what is under it, and said so: one
 * odd node never loses the whole snapshot.
 */
export function formatSnapshot(
  data: unknown,
  remember: (ref: string, element: Element) => void,
  max = SNAPSHOT_CHARS,
  within: { ref: string; element: Element } | null = null,
): { text: string; app: string | null; focused: Element | null } {
  if (!isRecord(data)) return { text: "Empty snapshot.", app: null, focused: null };
  const app = str(data.app) || null;
  const window = isRecord(data.window) ? data.window : {};
  const head = [
    app ? `App ${quoted(app)}` : "Snapshot",
    str(window.title) ? `, window ${quoted(str(window.title))}` : "",
    str(window.id) ? ` (${str(window.id)})` : "",
    data.complete === false ? ", partial: raise detail with root" : "",
  ].join("");
  const title = str(window.title);
  const where = app ? (title && title !== app ? `${app} ${title}` : app) : (within?.element.context?.app ?? title);
  const lines = [head];
  let size = head.length;
  let count = 0;
  let cut = false;
  let deep = false;
  let skipped = 0;
  let focused: Element | null = null;

  // Text fields under a container, down to three levels, with the child each one is under. Remembered per container.
  const fieldMemo = new Map<unknown, FoundField[]>();
  const fieldsIn = (container: Record<string, unknown>, depth: number): FoundField[] => {
    let found = fieldMemo.get(container);
    if (!found) {
      const list: FoundField[] = [];
      const visit = (node: unknown, level: number, branch: unknown) => {
        if (list.length >= 20 || !isRecord(node)) return;
        try {
          const element = elementOf(node);
          if (isTextEntry(element)) list.push({ field: { role: element.role, name: element.name }, branch, depth: level });
          if (level < 3) for (const child of childrenOf(node)) visit(child, level + 1, branch);
        } catch {
          // An unreadable node is no text field.
        }
      };
      for (const child of childrenOf(container)) visit(child, 1, child);
      fieldMemo.set(container, list);
      found = list;
    }
    return found.filter((item) => item.depth <= depth);
  };
  // A text field beside the node: a sibling, or a cousin under the same container. A window's direct children only.
  const fieldNear = (raw: Record<string, unknown>, place: Place): Element | null => {
    const { parent, grand } = place;
    const rootish = (node: Record<string, unknown>) => WINDOW_ROLES.test(str(node.role));
    const near = [
      ...(parent ? fieldsIn(parent, rootish(parent) ? 1 : 2).filter((item) => item.branch !== raw) : []),
      ...(parent && grand && !rootish(grand) ? fieldsIn(grand, 3).filter((item) => item.branch !== parent) : []),
    ];
    return near.find((item) => !isNavField(item.field))?.field ?? near[0]?.field ?? null;
  };
  // Short labels of the nearest siblings, nearest first: UI labels, not content.
  const neighbours = (place: Place): string[] => {
    const labels: string[] = [];
    for (let step = 1; step <= NEIGHBOURS; step += 1) {
      for (const sibling of [place.siblings[place.index - step], place.siblings[place.index + step]]) {
        let label = "";
        try {
          label = isRecord(sibling) ? elementOf(sibling).name.replace(/\s+/g, " ").trim() : "";
        } catch {
          // An unreadable neighbour has no label; it is left out on its own turn.
        }
        if (label && label.length <= LABEL_MAX) labels.push(label);
      }
    }
    return labels;
  };
  const contextOf = (raw: Record<string, unknown>, place: Place): TreeContext => ({ app: where, ancestors: place.ancestors, nearby: neighbours(place), field: fieldNear(raw, place) });

  // A root snapshot's region sits under the ref it read: keep the containers above that ref (and the ref, when the tree's top
  // is not the ref itself).
  const tree = isRecord(data.tree) ? data.tree : null;
  const above = within?.element.context?.ancestors ?? [];
  const top = within && tree && str(tree.ref_id) === within.ref ? above : within ? [asAncestor(within.element), ...above] : [];
  const walk = (raw: unknown, depth: number, place: Place) => {
    if (cut || !isRecord(raw)) return;
    if (depth > MAX_DEPTH) {
      deep = true;
      return;
    }
    if (count >= MAX_NODES) {
      cut = true;
      return;
    }
    count += 1;
    let line: string | null;
    let children: unknown[];
    let ancestors: readonly Element[];
    try {
      const ref = str(raw.ref_id);
      if (ref && REF_PATTERN.test(ref)) {
        const element: Element = { ...elementOf(raw), context: contextOf(raw, place) };
        remember(ref, element);
        if (focusedNode(raw)) focused = element;
      }
      line = elementLine(raw, depth);
      children = childrenOf(raw);
      ancestors = children.length > 0 ? [asAncestor(elementOf(raw)), ...place.ancestors].slice(0, MAX_ANCESTORS) : [];
    } catch {
      skipped += 1;
      return;
    }
    if (line) {
      if (size + line.length + 1 > max) {
        cut = true;
        return;
      }
      lines.push(line);
      size += line.length + 1;
    }
    for (let index = 0; index < children.length && !cut; index += 1) {
      walk(children[index], line ? depth + 1 : depth, { parent: raw, grand: place.parent, siblings: children, index, ancestors });
    }
  };
  walk(tree, 0, { parent: null, grand: null, siblings: [], index: 0, ancestors: top.slice(0, MAX_ANCESTORS) });
  if (skipped > 0) lines.push(`… ${skipped} element${skipped === 1 ? "" : "s"} could not be read and ${skipped === 1 ? "is" : "are"} left out.`);
  if (deep && !cut) lines.push("… deeper elements not shown: snapshot one region with root.");
  if (cut) lines.push("… more not shown: snapshot one region with root, or use find.");
  return { text: lines.join("\n"), app, focused };
}

/** find: one line per match (refs remembered with their own labels), or the count, or what roles are there when nothing matched. */
export function formatMatches(data: unknown, remember: (ref: string, element: Element) => void): string {
  if (typeof data === "number") return `${data} matches.`;
  if (!isRecord(data)) return "No matches.";
  if (typeof data.count === "number" && !Array.isArray(data.matches)) return `${data.count} matches.`;
  const matches = Array.isArray(data.matches) ? data.matches.filter(isRecord) : [];
  if (matches.length === 0) {
    const roles = Array.isArray(data.roles_present) ? data.roles_present.filter((role): role is string => typeof role === "string").slice(0, 20) : [];
    return roles.length > 0 ? `No matches. Roles here: ${roles.join(", ")}.` : "No matches.";
  }
  // A match Bee cannot read is left out; the others still come back.
  const lines = matches.slice(0, FIND_LIMIT).flatMap((match) => {
    try {
      const ref = str(match.ref_id);
      if (ref && REF_PATTERN.test(ref)) remember(ref, elementOf(match));
      const line = elementLine(match, 0) ?? str(match.role);
      return line ? [line] : [];
    } catch {
      return [];
    }
  });
  return lines.length > 0 ? lines.join("\n") : "No matches Bee could read.";
}

/** A whole-window snapshot that may still be settling: very few refs, or out of budget with few. */
export function thinTree(data: unknown): boolean {
  const count = refCount(data);
  return count < THIN_REFS || (isRecord(data) && data.complete === false && count < PARTIAL_REFS);
}

/** How many refs a snapshot holds: its ref_count, else counted in its tree (up to 5000 nodes). */
export function refCount(data: unknown): number {
  if (!isRecord(data)) return 0;
  if (typeof data.ref_count === "number" && Number.isFinite(data.ref_count)) return data.ref_count;
  let found = 0;
  let seen = 0;
  const stack: unknown[] = [data.tree];
  while (stack.length > 0 && seen < 5000) {
    const node = stack.pop();
    seen += 1;
    try {
      if (!isRecord(node)) continue;
      if (typeof node.ref_id === "string" && REF_PATTERN.test(node.ref_id)) found += 1;
      if (Array.isArray(node.children)) for (const child of node.children.slice(0, 5000)) stack.push(child);
    } catch {
      // Not counted.
    }
  }
  return found;
}

/** A successful action: how it was delivered, and any menu, sheet or alert it left open. */
export function formatDone(data: unknown): string {
  const record = isRecord(data) ? data : {};
  const disposition = isRecord(record.disposition) ? str(record.disposition.delivery) : "";
  const surfaces = Array.isArray(record.surfaces)
    ? record.surfaces.map((surface) => (isRecord(surface) ? str(surface.kind) || str(surface.surface) || str(surface.type) : str(surface))).filter(Boolean)
    : [];
  return [
    `Done${disposition ? ` (${disposition})` : ""}.`,
    surfaces.length > 0 ? ` Open now: ${[...new Set(surfaces)].slice(0, 5).join(", ")}. Act on it next: snapshot with that surface.` : "",
  ].join("");
}

/** get and is: the answer as short JSON. */
const formatRead = (data: unknown) => clip(JSON.stringify(data ?? null) ?? "null", 1500);

/** The PNG in a screenshot envelope (base64), or null. */
export function screenshotData(data: unknown): string | null {
  const candidates = typeof data === "string" ? [data] : isRecord(data) ? ["base64", "data", "png", "image", "content"].map((key) => data[key]) : [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.length > SCREENSHOT_MAX_CHARS) continue;
    const body = candidate.replace(/^data:image\/png;base64,/, "");
    if (/^[A-Za-z0-9+/]{100}/.test(body)) return body;
  }
  return null;
}

/** A PNG's width and height in pixels, from its header (the first 24 bytes), or null. */
export function pngSize(base64: string): { width: number; height: number } | null {
  let head: string;
  try {
    head = atob(base64.slice(0, 32));
  } catch {
    return null;
  }
  if (head.length < 24 || head.slice(1, 4) !== "PNG" || head.slice(12, 16) !== "IHDR") return null;
  const int = (at: number) => head.charCodeAt(at) * 0x1000000 + (head.charCodeAt(at + 1) << 16) + (head.charCodeAt(at + 2) << 8) + head.charCodeAt(at + 3);
  const [width, height] = [int(16), int(20)];
  return width > 0 && height > 0 && width <= 100_000 && height <= 100_000 ? { width, height } : null;
}

/** Where a spot in a screenshot is on screen, or why it cannot be placed. */
export type ScreenPoint = { x: number; y: number } | "resized" | "outside";

/**
 * A spot in a window's screenshot, x and y from 0 to 1000 across and down the picture (so it does not matter how the AI's
 * picture was scaled on the way), as a screen point inside the window's bounds now. The picture can be larger than the bounds
 * (2x on a Retina display) and can carry an even margin (a window shadow). "resized": the picture no longer fits the window.
 * "outside": the spot is in the margin, off the window.
 */
export function screenPoint(shot: { width: number; height: number }, bounds: AdBounds, x: number, y: number): ScreenPoint {
  const [sx, sy] = [shot.width / bounds.width, shot.height / bounds.height];
  const whole = Math.round(Math.min(sx, sy));
  let scale: number;
  let [mx, my] = [0, 0];
  if (whole >= 1 && Math.abs(Math.min(sx, sy) - whole) <= 0.1 * whole) {
    // A whole scale (1x, 2x) with an even margin: a shadow around the picture, or a thin border the picture leaves out. Margins
    // that differ much across and down mean the window changed size.
    scale = whole;
    mx = (shot.width - bounds.width * scale) / 2;
    my = (shot.height - bounds.height * scale) / 2;
    if (Math.abs(mx) > shot.width * 0.15 || Math.abs(my) > shot.height * 0.15 || Math.abs(mx - my) > 0.03 * Math.max(shot.width, shot.height)) return "resized";
  } else if (Math.abs(sx - sy) <= 0.03 * Math.max(sx, sy)) {
    // Another scale (125%, 150%), the same both ways.
    scale = (sx + sy) / 2;
  } else {
    return "resized";
  }
  if (scale < 0.25 || scale > 4) return "resized";
  const px = bounds.x + ((x / 1000) * shot.width - mx) / scale;
  const py = bounds.y + ((y / 1000) * shot.height - my) / scale;
  if (px < bounds.x || py < bounds.y || px > bounds.x + bounds.width || py > bounds.y + bounds.height) return "outside";
  // Whole numbers, one in from the far edges so the click stays on the window.
  return { x: Math.min(Math.round(px), Math.floor(bounds.x + bounds.width) - 1), y: Math.min(Math.round(py), Math.floor(bounds.y + bounds.height) - 1) };
}

// Unshifted punctuation by the key name agent-desktop press takes; each is sent with the key that types it in the keyboard
// layout in use. Shifted symbols (! ? @ …) sit on different keys in different layouts, so they are never guessed.
const KEY_NAMES: Record<string, string> = {
  " ": "space", ",": "comma", ".": "period", "/": "slash", ";": "semicolon", "'": "quote", "[": "leftbracket", "]": "rightbracket",
  "\\": "backslash", "-": "minus", "=": "equal", "`": "grave",
};

/** Text as key presses for press: letters (Shift for a capital), digits, space and KEY_NAMES. odd: the characters left out. */
export function keysFor(text: string): { keys: string[]; odd: string[] } {
  const keys: string[] = [];
  const odd = new Set<string>();
  for (const char of text) {
    if (/^[a-z0-9]$/.test(char)) keys.push(char);
    else if (/^[A-Z]$/.test(char)) keys.push(`shift+${char.toLowerCase()}`);
    else if (Object.hasOwn(KEY_NAMES, char)) keys.push(KEY_NAMES[char] as string);
    else odd.add(char);
  }
  return { keys, odd: [...odd] };
}

/** A text the AI gave for typing or a name: no control characters other than tabs and line breaks. */
const cleanText = (text: string) => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");

/** An app name the AI gave, ready for --app=, or null when it is not a plain name. */
function cleanApp(raw: string): string | null {
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name || name.length > APP_NAME_MAX || name.startsWith("-") || /[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

const refSchema = z.string().min(1).max(60).describe("A ref from the latest snapshot or find, for example @s8f3k2p9:e12.");
const appSchema = z.string().min(1).max(APP_NAME_MAX).describe("The app's name as list_apps shows it, for example Discord or Google Chrome.");
const windowSchema = z.string().max(60).describe("A window id from list_windows (w-…), when the app has several windows.");
const effectSchema = z
  .enum(EFFECTS)
  .describe("What this action does: send (sends a message, email or post, including Return in a chat box), delete, buy (pays or orders), submit (submits a form), or none.");
const physicalSchema = z.boolean().optional().describe("Real key presses or focus. Only when POLICY_DENIED said this step needs it. Never to retry other errors.");

type ScreenshotOutput = { text: string; image?: string };

/** What has keyboard focus after click_at: a text field, something else, or unknown (the tree could not say). */
type PointFocus = { kind: "text" | "other" | "unknown"; element: Element | null; ref: string | null };
/** The last click_at, while focus has not moved since: where it clicked, what the AI said it was, and what got focus. */
type Point = { app: string; windowId: string | undefined; target: string; focus: PointFocus };

// What the AI called the spot it clicked: a text field, unless it also reads as a control.
const TEXT_TARGET = /\b(?:box|field|input|compose|composer|editor|text|textarea|textbox|message|reply|comment|search|type|write|chat ?bar)\b/i;
const CONTROL_TARGET = /\b(?:button|icon|tab|link|menu|item|list|row|checkbox|toggle|switch|dropdown|picker|avatar|image|arrow|header|title|sidebar)\b/i;
const textTarget = (target: string) => TEXT_TARGET.test(target) && !CONTROL_TARGET.test(target);
// Code editors and IDEs, whose focus may be in a built-in terminal: Bee never types key presses into one without a ref.
const EMBEDS_SHELL = /\b(?:code|visual studio|cursor|windsurf|zed|xcode|intellij|pycharm|webstorm|goland|rider|clion|phpstorm|rubymine|android studio|sublime text|eclipse|netbeans)\b/i;

const NEEDS_REF = "Error: give a ref from this task's latest snapshot or find. If the app gives no refs, take a screenshot, click the field with click_at, then call type_text without ref.";
const NO_BREAKS = "Error: without a ref, type_text types no line breaks. Type the text, then use press_key: return sends in most chat apps, shift+return adds a line.";
const UNREADABLE = "Error: Bee could not read that snapshot. Take a skeleton snapshot, then root one region; or take a screenshot and use click_at.";
const THIN_NOTE = "Few elements came back: the app may still be loading. Wait, then snapshot again; or take a screenshot and use click_at.";

/** Focus after typing without a ref into a field Bee never saw: a text field with no name, so Return always asks as a send. */
const typedField = (app: string): Element => ({ role: "textfield", name: "", context: { app, ancestors: [], nearby: [], field: null } });

/** The computer tools over the given runners. One call at a time, in order; each is one step. */
export function computerTools(deps: ComputerToolDeps) {
  const { control } = deps;
  // Refs this run has seen, with what they are and where they sit, and where keyboard focus is as far as Bee knows: the field
  // written last, a text field clicked, or what a snapshot showed focused. Null once a key, a click or an app switch may have
  // moved it, so Return asks again.
  const refs = new Map<string, Element>();
  // Window ids this run has shown the AI (never one of an app Bee does not use).
  const windows = new Set<string>();
  let lastField: Element | null = null;
  // The last click_at while focus stays where it put it (null once a key, a ref action or an app switch may have moved it), and
  // whether this run has typed or set any text (a click at a point may then send a draft, so it asks).
  let point: Point | null = null;
  let typed = false;
  // The size of the latest screenshot of each app (by appKey), for click_at. Null: the picture's size could not be read.
  const shots = new Map<string, { width: number; height: number; windowId: string | undefined } | null>();
  // The app the run last read or acted in, for the Confirm prompt's detail.
  let currentApp: string | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const remember = (ref: string, element: Element) => refs.set(ref, element);

  /** UI actions must not interleave: parallel tool calls run one after another, in the order the AI made them. */
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work);
    chain = next.catch(() => undefined);
    return next;
  };

  /**
   * One agent-desktop command for this run. A permission refusal (other than Screen Recording) ends the run. A failure is logged
   * with agent-desktop's message (redacted); a command the allowlist refuses never starts and comes back as REFUSED.
   */
  const exec = async (command: ComputerUseCommand, args: string[], timeoutMs: number): Promise<AgentDesktopResult> => {
    const started = performance.now();
    let result: AgentDesktopResult;
    try {
      result = await deps.run(command, args, { timeoutMs, signal: control.signal });
    } catch (error) {
      debugLog.warn("computer", "exec-refused", { command, args, ms: msSince(started), error: errorData(error).message });
      return { ok: false, code: "REFUSED" };
    }
    debugLog.debug("computer", "exec", { command, args, ok: result.ok, code: result.ok ? null : result.code, ms: msSince(started) });
    if (!result.ok) {
      debugLog.warn("computer", "exec-failed", { command, code: result.code, message: result.message ?? null, retry: result.retry ?? null, kind: result.kind ?? null, timeoutMs, ms: msSince(started) });
      console.debug(`computer ${command} ${result.code}`);
      if (result.code === "PERM_DENIED" && command !== "screenshot") control.stop("permission");
    }
    return result;
  };

  /** A failed read that a second one may fix: agent-desktop says nothing was delivered, so a retry is safe. */
  const lookAgain = (result: AgentDesktopResult) =>
    !result.ok && (LOOK_AGAIN.has(result.code) || LOOK_AGAIN_KIND.test(result.kind ?? "")) && result.retry === "safe" && !control.reason();

  /**
   * snapshot or find, read again once in a new process with the longer budget (args(budget, again)) when the first read failed
   * where a retry is safe, or came back thin. A thin first read still beats a failed or thinner second one.
   */
  const observe = async (command: "snapshot" | "find", args: (budget: number, again: boolean) => string[], thin?: (data: unknown) => boolean): Promise<AgentDesktopResult> => {
    const first = await exec(command, args(LOOK_TIMEOUT_MS, false), LOOK_TIMEOUT_MS + KILL_MARGIN_MS);
    if (!(first.ok ? (thin?.(first.data) ?? false) && !control.reason() : lookAgain(first))) return first;
    debugLog.info("computer", "look-again", { command, why: first.ok ? "thin" : first.code, refs: first.ok ? refCount(first.data) : null });
    deps.onStep?.("Waiting for the app…");
    const second = await exec(command, args(SETTLE_TIMEOUT_MS, true), SETTLE_TIMEOUT_MS + KILL_MARGIN_MS);
    if (first.ok && (!second.ok || refCount(second.data) < refCount(first.data))) return first;
    return second;
  };

  /** get or is, once more when a retry is safe. */
  const readOnce = async (command: "get" | "is", args: string[]): Promise<AgentDesktopResult> => {
    const first = await exec(command, args, READ_MS);
    return lookAgain(first) ? exec(command, args, READ_MS) : first;
  };

  /**
   * Runs one tool step: counts it, shows its line, asks first when the gate says so, then does the work. A step after the run
   * stopped does nothing.
   */
  const step = <T extends string | ScreenshotOutput>(name: string, label: string, work: () => Promise<T>, gate?: () => GateAction): Promise<T | string> =>
    serial(async () => {
      if (!control.step()) {
        debugLog.info("computer", "step-refused", { tool: name, reason: control.reason(), steps: control.steps() });
        return STOPPED;
      }
      const started = performance.now();
      debugLog.info("computer", "step", { n: control.steps(), tool: name, label, app: currentApp });
      deps.onStep?.(clip(label, 60));
      deps.onActivity?.({ tool: name, phase: "start" });
      try {
        if (gate && deps.askFirst()) {
          const action = gate();
          const kind = needsConfirm(action, deps.askFirst());
          if (kind) {
            deps.onStep?.(CONFIRM_LABEL);
            const request: ConfirmRequest = { kind, question: confirmQuestion(kind), detail: confirmDetail(action, currentApp) };
            debugLog.info("computer", "confirm-needed", { tool: name, kind, request, action });
            const confirmed = await control.paused(() => awaitAnswer((signal) => deps.confirm(request, signal), control.signal, deps.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS));
            debugLog.info("computer", "confirm-result", { tool: name, kind, confirmed, reason: control.reason() });
            if (!confirmed) {
              control.stop("declined", kind);
              return STOPPED;
            }
            console.debug(`computer confirmed ${kind}`);
            deps.onStep?.(clip(label, 60));
          }
        }
        if (control.reason()) return STOPPED;
        const output = await work();
        debugLog.debug("computer", "step-done", { n: control.steps(), tool: name, ms: msSince(started), output });
        return output;
      } catch (error) {
        debugLog.warn("computer", "step-failed", { n: control.steps(), tool: name, ms: msSince(started), reason: control.reason(), error: error instanceof Error ? error.message : String(error) });
        return control.reason() ? STOPPED : "Error: that step failed. Look again before trying something else.";
      } finally {
        deps.onActivity?.({ tool: name, phase: "end" });
      }
    });

  /** A ref the AI gave: one this run's snapshots or finds showed it, else the error to send back. */
  const badRef = (ref: string): string | null => (REF_PATTERN.test(ref) && refs.has(ref) ? null : "Error: use a ref from this task's latest snapshot or find, for example @s8f3k2p9:e12.");
  const badApp = (name: string | undefined): string | null => {
    if (name === undefined) return null;
    const app = cleanApp(name);
    if (!app) return "Error: that is not an app name. Check list_apps.";
    return offLimitsApp(app) ? OFF_LIMITS_MESSAGE : null;
  };
  const badWindow = (id: string | undefined) => (id === undefined || windows.has(id) ? null : "Error: use a window id from list_windows.");
  const label = (ref: string, verb: string, fallback: string) => {
    const name = refs.get(ref)?.name;
    return name ? `${verb} ${shortName(name, 30)}…` : fallback;
  };
  const scope = (args: { app?: string; window_id?: string }) => [...(args.app ? [`--app=${cleanApp(args.app)}`] : []), ...(args.window_id ? [`--window-id=${args.window_id}`] : [])];
  const done = (result: AgentDesktopResult) => (result.ok ? formatDone(result.data) : errorLine(result));
  const desktopLine = (result: DesktopActionResult) => (result.ok ? `Done: ${result.message}.` : `Error: ${result.message}.`);

  /** A ref action: check the ref, run it, and keep where focus is for Return. Never in a terminal or console. */
  const onRef = (command: ComputerUseCommand, ref: string, args: string[] = [], timeoutMs = ACT_MS) => async () => {
    if (["click", "type", "set-value", "clear", "focus"].includes(command) && shellElement(refs.get(ref))) return SHELL_MESSAGE;
    const result = await exec(command, [ref, ...args], timeoutMs);
    // Focus may have left the spot click_at put it.
    if (["click", "type", "focus", "select"].includes(command)) point = null;
    if (result.ok && ["type", "set-value", "clear", "focus"].includes(command)) lastField = refs.get(ref) ?? lastField;
    if (result.ok && ["type", "set-value"].includes(command)) typed = true;
    if (result.ok && command === "click") lastField = focusAfterClick(lastField, refs.get(ref));
    return done(result);
  };

  /** What has keyboard focus in the app after a click at a point, from a short find. Unknown when the tree cannot say. */
  const focusNow = async (app: string, windowId: string | undefined): Promise<PointFocus> => {
    const unknown: PointFocus = { kind: "unknown", element: null, ref: null };
    const result = await exec("find", [...scope({ app, window_id: windowId }), "--state=focused", "--limit=5", `--timeout-ms=${FOCUS_TIMEOUT_MS}`], FOCUS_TIMEOUT_MS + KILL_MARGIN_MS);
    if (!result.ok || !isRecord(result.data) || !Array.isArray(result.data.matches)) return unknown;
    try {
      const matches = result.data.matches.filter(isRecord).filter((match) => !WINDOW_ROLES.test(str(match.role)));
      const match = matches.find((item) => isTextEntry(elementOf(item))) ?? matches[0];
      if (!match) return unknown;
      const element = elementOf(match);
      const ref = str(match.ref_id);
      const kept = REF_PATTERN.test(ref) ? ref : null;
      if (kept) remember(kept, refs.get(kept)?.context ? { ...element, context: refs.get(kept)?.context } : element);
      return { kind: isTextEntry(element) ? "text" : "other", element, ref: kept };
    } catch {
      return unknown;
    }
  };

  /** What click_at says about focus, so the AI knows whether and how to type. */
  const focusLine = (focus: PointFocus): string => {
    const what = focus.element ? `${focus.element.role || "element"}${focus.element.name ? ` ${quoted(focus.element.name)}` : ""}` : "";
    if (focus.kind === "text") return `The cursor is in ${what}${focus.ref ? ` ${focus.ref}` : ""}. type_text without ref types there.`;
    if (focus.kind === "other") return `Focus is on ${what}, not a text field. To type, click_at the text field itself.`;
    return "Bee cannot see what has focus. If that was a text field, type_text without ref types there. Check the result with a screenshot.";
  };

  /** Why a click at a point cannot run now, or null. Read when the step runs, after the steps queued before it. */
  const clickRefusal = (input: { app: string; window_id?: string }): string | null => {
    const invalid = badApp(input.app) ?? badWindow(input.window_id);
    if (invalid) return invalid;
    const key = appKey(cleanApp(input.app) ?? "");
    if (!shots.has(key)) return "Error: take a screenshot of that app first. click_at takes a spot in it.";
    return shots.get(key) ? null : "Error: Bee could not read that screenshot's size, so it cannot place a spot in it. Use snapshot and refs.";
  };

  /** A left click at a spot in the app's latest screenshot: the window comes forward, then a real click at the screen point. */
  const clickAt = async (input: { app: string; window_id?: string; x: number; y: number; target: string }): Promise<string> => {
    const refused = clickRefusal(input);
    if (refused) return refused;
    const app = cleanApp(input.app) as string;
    const shot = shots.get(appKey(app));
    if (!shot) return "Error: take a screenshot of that app first. click_at takes a spot in it.";

    const windowId = input.window_id ?? shot.windowId;
    // In front, so the click lands on this window and not on one over it.
    const front = await deps.desktop.focusWindow({ app });
    if (!front.ok) debugLog.info("computer", "click-at-front", { app, message: front.message });
    const listed = await exec("list-windows", scope({ app }), READ_MS);
    if (!listed.ok) return errorLine(listed, true);
    const open = parseWindows(listed.data).filter((window) => !offLimitsApp(window.app));
    const window = windowId ? open.find((item) => item.id === windowId) : open.length === 1 ? open[0] : open.find((item) => item.focused);
    if (!window) return windowId ? "Error: that window is gone. Check list_windows." : "Error: that app has several windows. Pass window_id from list_windows, and take the screenshot with it.";
    for (const item of open) windows.add(item.id);
    if (!window.bounds) return "Error: Bee cannot tell where that window is on screen. Use snapshot and refs instead.";
    const spot = screenPoint(shot, window.bounds, input.x, input.y);
    if (spot === "resized") return "Error: the window changed size since the screenshot. Take a new screenshot.";
    if (spot === "outside") return "Error: that spot is outside the window. Check the screenshot.";
    const result = await exec("mouse-click", [`--xy=${spot.x},${spot.y}`, HEADED_FLAG], ACT_MS);
    // Whatever had focus, it may not have it now.
    [lastField, point, currentApp] = [null, null, app];
    if (!result.ok) return errorLine(result);
    const focus = await focusNow(app, window.id);
    point = { app, windowId: window.id, target: input.target, focus };
    lastField = focus.element;
    return `${formatDone(result.data)} ${focusLine(focus)}`;
  };

  /** Why key presses cannot type this text into the app, or null. */
  const keysRefusal = (app: string, text: string): string | null => {
    if (EMBEDS_SHELL.test(app)) return "Error: Bee does not type into a code editor without a ref: its focus may be in a terminal. Use snapshot or find for a ref.";
    const { keys, odd } = keysFor(text);
    if (odd.length > 0) return `Error: without a ref, Bee types only letters, digits, spaces and , . / ; ' [ ] \\ - = \`. Leave out: ${clip(odd.join(" "), 40)}`;
    return keys.length > KEYS_MAX ? `Error: without a ref, type at most ${KEYS_MAX} characters at a time.` : null;
  };

  /** Why typing where click_at put the cursor cannot run now, or null. Read when the step runs, so a refused step asks nothing. */
  const typeRefusal = (text: string): string | null => {
    if (!point) return NEEDS_REF;
    if (/[\r\n]/.test(text)) return NO_BREAKS;
    const { focus, target } = point;
    if (focus.kind === "other") return "Error: focus is not in a text field. click_at the text field itself first.";
    if (focus.kind === "unknown" && !textTarget(target)) return "Error: click_at did not say it clicked a text field. click_at the text field itself first.";
    if (shellElement(focus.element) || shellElement({ role: "", name: target })) return SHELL_MESSAGE;
    return focus.ref ? null : keysRefusal(point.app, text);
  };

  /**
   * Typing where click_at put the cursor. With a ref for the focused field, agent-desktop types into it. Without one (or when
   * that was never delivered), each character goes as one key press to the app: letters, digits, space and plain punctuation
   * only, never Return, and never in a code editor (its focus may be a terminal). Physical either way.
   */
  const typeAtPoint = async (text: string): Promise<string> => {
    const refused = typeRefusal(text);
    if (refused || !point) return refused ?? NEEDS_REF;
    const { app, windowId, focus } = point;
    const field = focus.element ?? typedField(app);
    if (focus.ref) {
      const result = await exec("type", [focus.ref, HEADED_FLAG, "--", cleanText(text)], ACT_MS + Math.min(40_000, text.length * 40));
      if (result.ok) [lastField, typed] = [field, true];
      if (result.ok || result.retry !== "safe") return done(result);
      debugLog.info("computer", "type-as-keys", { code: result.code });
      const refusedKeys = keysRefusal(app, text);
      if (refusedKeys) return `${errorLine(result)} ${refusedKeys}`;
    }
    const { keys } = keysFor(text);
    for (const [index, key] of keys.entries()) {
      const result = control.reason() ? null : await exec("press", [key, ...scope({ app, window_id: windowId }), HEADED_FLAG], ACT_MS);
      if (result?.ok) continue;
      // Part of the text may be in the field now.
      if (index > 0) [lastField, typed] = [field, true];
      return result ? `${errorLine(result)} ${index} of ${keys.length} characters were typed: look before typing again.` : STOPPED;
    }
    [lastField, typed] = [field, true];
    return `Typed ${keys.length} characters as key presses (not checked). Check with a screenshot before pressing Return.`;
  };
  const gateFor = (command: string, ref: string, extra: Partial<GateAction> & { effect?: Effect }) => (): GateAction => ({ command, target: refs.get(ref) ?? null, lastField, ...extra });

  return {
    snapshot: tool({
      description:
        "Read an app's window as a list of elements; each one you can act on has a ref (@s8f3k2p9:e12). Call it before acting and after anything changes. For a busy app (Slack, Teams, Discord, Chrome, Outlook) use skeleton first, then root to read one region.",
      inputSchema: z.object({
        app: appSchema.optional().describe("The app to read. Needed unless root is given."),
        window_id: windowSchema.optional(),
        root: refSchema.optional().describe("A ref from this task's snapshots: read only that region."),
        surface: z.enum(SURFACES).optional().describe("An open menu, menubar, sheet, popover or alert instead of the window."),
        skeleton: z.boolean().optional().describe("A shallow map of a busy window; drill in with root."),
      }),
      execute: (input) =>
        step("snapshot", input.app ? `Looking at ${shortName(input.app, 30)}…` : "Looking at the screen…", async () => {
          if (!input.app && !input.root) return "Error: give app (or a root ref).";
          const invalid = badApp(input.app) ?? badWindow(input.window_id) ?? (input.root ? badRef(input.root) : null);
          if (invalid) return invalid;
          const skeleton = !!input.skeleton && !input.surface && !input.root;
          // Only a whole window can read thin; a region or a menu is small by nature.
          const whole = !input.root && !input.surface;
          const args = (budget: number, again: boolean) => [
            "--interactive-only",
            "--compact",
            ...(input.root ? [`--root=${input.root}`] : scope(input)),
            ...(input.surface && !input.root ? [`--surface=${input.surface}`] : []),
            ...(skeleton ? ["--skeleton"] : []),
            ...(again && whole && !skeleton ? [`--max-depth=${DEEP_DEPTH}`] : []),
            `--timeout-ms=${budget}`,
          ];
          const result = await observe("snapshot", args, whole ? thinTree : undefined);
          if (!result.ok) return errorLine(result, true);
          // Refs from an app Bee never uses are dropped before the AI sees them.
          const kept = new Map<string, Element>();
          const within = input.root ? refs.get(input.root) : undefined;
          let shown: ReturnType<typeof formatSnapshot>;
          try {
            shown = formatSnapshot(result.data, (ref, item) => kept.set(ref, item), SNAPSHOT_CHARS, input.root && within ? { ref: input.root, element: within } : null);
          } catch (error) {
            debugLog.warn("computer", "snapshot-unreadable", { error: errorData(error) });
            return UNREADABLE;
          }
          if (shown.app && offLimitsApp(shown.app)) return OFF_LIMITS_MESSAGE;
          for (const [ref, item] of kept) remember(ref, item);
          if (shown.focused) lastField = shown.focused;
          const shownWindow = isRecord(result.data) && isRecord(result.data.window) ? str(result.data.window.id) : "";
          if (/^w-[A-Za-z0-9-]{1,40}$/.test(shownWindow)) windows.add(shownWindow);
          currentApp = shown.app ?? (input.app ? cleanApp(input.app) : currentApp);
          return whole && thinTree(result.data) ? `${shown.text}\n${THIN_NOTE}` : shown.text;
        }),
    }),

    find: tool({
      description: "Find elements in an app by role (button, textfield, link, tab…) and name or text. Faster than a snapshot when you know what you want.",
      inputSchema: z.object({
        app: appSchema.optional().describe("The app to search. Needed unless root is given."),
        window_id: windowSchema.optional(),
        root: refSchema.optional().describe("Search only inside this ref's region."),
        surface: z.enum(SURFACES).optional(),
        role: z.string().max(30).optional(),
        name: z.string().max(200).optional(),
        text: z.string().max(200).optional().describe("Text anywhere in the element or inside it."),
        exact: z.boolean().optional(),
      }),
      execute: (input) =>
        step("find", input.name || input.text ? `Looking for ${shortName(input.name || input.text || "", 30)}…` : "Looking at the screen…", async () => {
          if (!input.app && !input.root) return "Error: give app (or a root ref).";
          const invalid = badApp(input.app) ?? badWindow(input.window_id) ?? (input.root ? badRef(input.root) : null);
          if (invalid) return invalid;
          if (input.role && !/^[A-Za-z]{2,30}$/.test(input.role)) return "Error: role is one word, for example button.";
          const args = [
            ...(input.root ? [`--root=${input.root}`] : scope(input)),
            ...(input.surface && !input.root ? [`--surface=${input.surface}`] : []),
            ...(input.role ? [`--role=${input.role}`] : []),
            ...(input.name ? [`--name=${cleanText(input.name)}`] : []),
            ...(input.text ? [`--text=${cleanText(input.text)}`] : []),
            ...(input.exact ? ["--exact"] : []),
            `--limit=${FIND_LIMIT}`,
          ];
          const result = await observe("find", (budget) => [...args, `--timeout-ms=${budget}`]);
          // A match keeps where it sits when a snapshot showed it, or sits inside root when one was given.
          const inside = insideOf(input.root ? refs.get(input.root) : null);
          const found = (ref: string, item: Element) => {
            const context = refs.get(ref)?.context ?? inside;
            remember(ref, context ? { ...item, context } : item);
          };
          return result.ok ? formatMatches(result.data, found) : errorLine(result, true);
        }),
    }),

    read: tool({
      description: "Read one property of a ref: text (what a person reads), value, title, role or states.",
      inputSchema: z.object({ ref: refSchema, property: z.enum(["text", "value", "title", "role", "states"]).optional() }),
      execute: ({ ref, property }) =>
        step("read", "Reading the screen…", async () => {
          const invalid = badRef(ref);
          if (invalid) return invalid;
          const result = await readOnce("get", [ref, `--property=${property ?? "text"}`]);
          return result.ok ? formatRead(result.data) : errorLine(result, true);
        }),
    }),

    check_state: tool({
      description: "Check one state of a ref: visible, enabled, checked, focused, expanded or selected.",
      inputSchema: z.object({ ref: refSchema, property: z.enum(["visible", "enabled", "checked", "focused", "expanded", "selected"]) }),
      execute: ({ ref, property }) =>
        step("check_state", "Reading the screen…", async () => {
          const invalid = badRef(ref);
          if (invalid) return invalid;
          const result = await readOnce("is", [ref, `--property=${property}`]);
          return result.ok ? formatRead(result.data) : errorLine(result, true);
        }),
    }),

    screenshot: tool({
      description: "A picture of one app's window, when the element list is not enough (a canvas, an image, a layout). Prefer snapshot: it gives refs.",
      inputSchema: z.object({ app: appSchema, window_id: windowSchema.optional() }),
      execute: (input) =>
        step("screenshot", `Looking at ${shortName(input.app, 30)}…`, async (): Promise<ScreenshotOutput> => {
          const invalid = badApp(input.app) ?? badWindow(input.window_id);
          if (invalid) return { text: invalid };
          const result = await exec("screenshot", scope(input), READ_MS);
          if (!result.ok) return { text: result.code === "PERM_DENIED" ? "Error PERM_DENIED: Screen Recording is off for Bee. Use snapshot instead." : errorLine(result, true) };
          const image = screenshotData(result.data);
          if (!image) return { text: "Error: no picture came back. Use snapshot instead." };
          // Its size, so click_at can place a spot in it on screen.
          const size = pngSize(image);
          const app = cleanApp(input.app);
          if (app) shots.set(appKey(app), size ? { ...size, windowId: input.window_id } : null);
          return { text: `Screenshot of ${clip(input.app, 40)}.`, image };
        }),
      toModelOutput: ({ output }) => {
        const shot = typeof output === "string" ? { text: output } : (output as ScreenshotOutput);
        return shot.image
          ? { type: "content", value: [{ type: "text", text: shot.text }, { type: "file", data: { type: "data", data: shot.image }, mediaType: "image/png" }] }
          : { type: "text", value: shot.text };
      },
    }),

    list_apps: tool({
      description: "The apps running now, by the names other tools take.",
      inputSchema: z.object({}),
      execute: () =>
        step("list_apps", "Checking open apps…", async () => {
          const result = await exec("list-apps", [], READ_MS);
          if (!result.ok) return errorLine(result, true);
          const names = parseApps(result.data).map((app) => app.name);
          return names.length > 0 ? names.slice(0, 60).join(", ") : "No apps.";
        }),
    }),

    list_windows: tool({
      description: "The open windows, with ids for window_id, optionally for one app.",
      inputSchema: z.object({ app: appSchema.optional() }),
      execute: (input) =>
        step("list_windows", "Checking open windows…", async () => {
          const invalid = badApp(input.app);
          if (invalid) return invalid;
          const result = await exec("list-windows", scope(input), READ_MS);
          if (!result.ok) return errorLine(result, true);
          const listed = parseWindows(result.data)
            .filter((window) => !offLimitsApp(window.app))
            .slice(0, 40);
          for (const window of listed) windows.add(window.id);
          return listed.length > 0
            ? listed
                .map((window) => `${window.id} ${quoted(window.app)} ${quoted(window.title)}${window.focused ? " (focused)" : ""}`)
                .join("\n")
            : "No windows.";
        }),
    }),

    click: tool({
      description: "Click (press) the element with this ref.",
      inputSchema: z.object({ ref: refSchema, effect: effectSchema }),
      execute: ({ ref, effect }) => step("click", label(ref, "Clicking", "Clicking…"), async () => badRef(ref) ?? onRef("click", ref)(), gateFor("click", ref, { effect })),
    }),

    click_at: tool({
      description:
        "Click a spot in an app's window by where it is in your latest screenshot of that app, when snapshot and find give no ref for it (they fail, or come back empty). A real mouse click. After clicking into a text field, type_text without ref types there.",
      inputSchema: z.object({
        app: appSchema,
        window_id: windowSchema.optional(),
        x: z.number().int().min(0).max(1000).describe("Across the screenshot: 0 is its left edge, 1000 its right edge."),
        y: z.number().int().min(0).max(1000).describe("Down the screenshot: 0 is its top edge, 1000 its bottom edge."),
        target: z.string().min(1).max(80).describe("What is at that spot, as you see it: message box, Send button, Chat tab."),
        effect: effectSchema,
      }),
      execute: (input) =>
        step(
          "click_at",
          `Clicking ${shortName(input.target, 30)}…`,
          () => clickAt(input),
          // The gate has no tree here: what the AI says it clicks, the app, and whether the run has typed (core/computer-gate.ts).
          (): GateAction =>
            clickRefusal(input)
              ? { command: "none" }
              : { command: "click-at", target: { role: "", name: input.target, context: { app: cleanApp(input.app) ?? "", ancestors: [], nearby: [], field: null } }, effect: input.effect, typed, lastField },
        ),
    }),

    type_text: tool({
      description:
        "Type text into a text field, as keystrokes. A line break presses Return, which sends in most chat apps. Without ref, it types where click_at just put the cursor: no line breaks (use press_key for Return), always real keys.",
      inputSchema: z.object({
        ref: refSchema.optional().describe("The text field's ref. Leave it out only right after click_at into a text field."),
        text: z.string().min(1).max(4000),
        effect: effectSchema,
        physical: physicalSchema,
      }),
      execute: ({ ref, text, effect, physical }) =>
        ref !== undefined
          ? step(
              "type_text",
              label(ref, "Typing in", "Typing…"),
              async () => badRef(ref) ?? onRef("type", ref, [...(physical ? [HEADED_FLAG] : []), "--", cleanText(text)], ACT_MS + Math.min(40_000, text.length * 40))(),
              gateFor("type", ref, { effect, text }),
            )
          : step(
              "type_text",
              "Typing…",
              () => typeAtPoint(text),
              // A step that will be refused types nothing, so there is nothing to confirm.
              (): GateAction => (typeRefusal(text) ? { command: "none" } : { command: "type", target: point?.focus.element ?? null, text, effect, lastField }),
            ),
    }),

    set_value: tool({
      description: "Set a text field's whole value at once. Faster than type_text; use it for drafts and form fields.",
      inputSchema: z.object({ ref: refSchema, value: z.string().max(4000), effect: effectSchema }),
      execute: ({ ref, value, effect }) =>
        step(
          "set_value",
          label(ref, "Typing in", "Typing…"),
          async () => badRef(ref) ?? onRef("set-value", ref, ["--", cleanText(value)])(),
          gateFor("set-value", ref, { effect, text: value }),
        ),
    }),

    clear: tool({
      description: "Empty a text field.",
      inputSchema: z.object({ ref: refSchema }),
      execute: ({ ref }) => step("clear", label(ref, "Clearing", "Clearing a field…"), async () => badRef(ref) ?? onRef("clear", ref)()),
    }),

    focus: tool({
      description: "Put keyboard focus on an element without clicking it.",
      inputSchema: z.object({ ref: refSchema, physical: physicalSchema }),
      execute: ({ ref, physical }) => step("focus", label(ref, "Selecting", "Selecting a field…"), async () => badRef(ref) ?? onRef("focus", ref, physical ? [HEADED_FLAG] : [])()),
    }),

    select_option: tool({
      description: "Choose an option by its text in a list, dropdown or menu button.",
      inputSchema: z.object({ ref: refSchema, option: z.string().min(1).max(200), effect: effectSchema }),
      execute: ({ ref, option, effect }) =>
        step("select_option", `Choosing ${shortName(option, 30)}…`, async () => badRef(ref) ?? onRef("select", ref, ["--", cleanText(option)])(), gateFor("select", ref, { effect, text: option })),
    }),

    set_checked: tool({
      description: "Tick or untick a checkbox or switch.",
      inputSchema: z.object({ ref: refSchema, checked: z.boolean() }),
      execute: ({ ref, checked }) =>
        step("set_checked", label(ref, checked ? "Ticking" : "Unticking", checked ? "Ticking a box…" : "Unticking a box…"), async () => badRef(ref) ?? onRef(checked ? "check" : "uncheck", ref)()),
    }),

    expand: tool({
      description: "Expand or collapse a disclosure, tree item or section.",
      inputSchema: z.object({ ref: refSchema, open: z.boolean() }),
      execute: ({ ref, open }) =>
        step("expand", label(ref, open ? "Expanding" : "Collapsing", open ? "Expanding…" : "Collapsing…"), async () => badRef(ref) ?? onRef(open ? "expand" : "collapse", ref)()),
    }),

    scroll: tool({
      description: "Scroll a scroll area (a ref) up, down, left or right.",
      inputSchema: z.object({ ref: refSchema, direction: z.enum(["up", "down", "left", "right"]), amount: z.number().int().min(1).max(20).optional() }),
      execute: ({ ref, direction, amount }) =>
        step("scroll", "Scrolling…", async () => badRef(ref) ?? onRef("scroll", ref, [`--direction=${direction}`, `--amount=${amount ?? 3}`])()),
    }),

    scroll_to: tool({
      description: "Scroll until an element is in view.",
      inputSchema: z.object({ ref: refSchema }),
      execute: ({ ref }) => step("scroll_to", "Scrolling…", async () => badRef(ref) ?? onRef("scroll-to", ref)()),
    }),

    press_key: tool({
      description:
        "Press keys in one app: return, escape, tab, delete, up, down, or a shortcut such as cmd+w (Mac) or ctrl+w (Windows) to close a tab. Punctuation by name: comma, period, slash.",
      inputSchema: z.object({ keys: z.string().min(1).max(40), app: appSchema, window_id: windowSchema.optional(), effect: effectSchema, physical: physicalSchema }),
      execute: (input) =>
        step(
          "press_key",
          `Pressing ${keysLabel(input.keys)}…`,
          async () => {
            const keys = input.keys.trim().toLowerCase().replace(/\s*\+\s*/g, "+");
            if (!/^[a-z0-9]{1,12}(?:\+[a-z0-9]{1,12}){0,4}$/.test(keys)) return "Error: keys look like return or cmd+w.";
            const invalid = badApp(input.app) ?? badWindow(input.window_id);
            if (invalid) return invalid;
            if (shellElement(lastField)) return SHELL_MESSAGE;
            currentApp = cleanApp(input.app) ?? currentApp;
            const result = await exec("press", [keys, ...scope(input), ...(input.physical ? [HEADED_FLAG] : [])], ACT_MS);
            if (!keepsFocus(keys)) [lastField, point] = [null, null];
            return result.ok ? `${formatDone(result.data)} Check the result with a snapshot.` : errorLine(result);
          },
          () => ({ command: "press", keys: input.keys.trim().toLowerCase().replace(/\s*\+\s*/g, "+"), lastField, effect: input.effect }),
        ),
    }),

    open_app: tool({
      description: "Open an app, or bring it to the front if it is open.",
      inputSchema: z.object({ name: z.string().min(1).max(APP_NAME_MAX) }),
      execute: ({ name }) =>
        step("open_app", `Opening ${shortName(name, 30)}…`, async () => {
          if (offLimitsApp(name)) return OFF_LIMITS_MESSAGE;
          const result = await deps.desktop.openApp(name);
          if (result.ok) [currentApp, lastField, point] = [name, null, null];
          return desktopLine(result);
        }),
    }),

    focus_window: tool({
      description: "Bring one app's window to the front, optionally the one whose title contains some text.",
      inputSchema: z.object({ app: z.string().min(1).max(APP_NAME_MAX), title: z.string().max(WINDOW_TITLE_MAX).optional() }),
      execute: ({ app, title }) =>
        step("focus_window", `Switching to ${shortName(app, 30)}…`, async () => {
          if (offLimitsApp(app)) return OFF_LIMITS_MESSAGE;
          const result = await deps.desktop.focusWindow({ app, ...(title ? { title } : {}) });
          if (result.ok) [currentApp, lastField, point] = [app, null, null];
          return desktopLine(result);
        }),
    }),

    open_url: tool({
      description: "Open a web page in the default browser, by its full https URL.",
      inputSchema: z.object({ url: z.string().min(1).max(2000) }),
      execute: ({ url }) =>
        step("open_url", "Opening the link…", async () => {
          const result = await deps.desktop.openUrl(url);
          if (result.ok) [lastField, point] = [null, null];
          return desktopLine(result);
        }),
    }),

    close_app: tool({
      description: "Quit an app (all its windows). To close one tab or window, use its close button or a shortcut instead.",
      inputSchema: z.object({ name: appSchema }),
      execute: ({ name }) =>
        step("close_app", `Closing ${shortName(name, 30)}…`, async () => {
          const app = cleanApp(name);
          if (!app) return "Error: that is not an app name. Check list_apps.";
          if (offLimitsApp(app) || ["finder", "explorer", "file explorer", "dock", "windows explorer"].includes(appKey(app))) return "Error: Bee does not quit that app.";
          const result = await exec("close-app", [app], ACT_MS);
          if (result.ok) [lastField, point] = [null, null];
          return done(result);
        }),
    }),

    wait: tool({
      description: "Wait: a number of milliseconds, or until a window title or some text appears in an app. Use after an action that loads something.",
      inputSchema: z.object({
        ms: z.number().int().min(100).max(WAIT_MAX_MS).optional(),
        for_window: z.string().max(200).optional().describe("Wait until a window whose title contains this appears."),
        for_text: z.string().max(200).optional().describe("Wait until this text appears in the app."),
        app: appSchema.optional(),
        timeout_ms: z.number().int().min(500).max(WAIT_MAX_MS).optional(),
      }),
      execute: (input) =>
        step("wait", "Waiting…", async () => {
          const invalid = badApp(input.app);
          if (invalid) return invalid;
          const timeout = input.timeout_ms ?? 8000;
          const what = input.for_window ? [`--window=${cleanText(input.for_window)}`] : input.for_text ? [`--text=${cleanText(input.for_text)}`] : null;
          if (input.for_text && !input.app) return "Error: give app with for_text.";
          const args = what ? [...what, ...scope(input), `--timeout=${timeout}`] : [String(input.ms ?? 1000)];
          const result = await exec("wait", args, (what ? timeout : (input.ms ?? 1000)) + 5000);
          return result.ok ? "Done." : errorLine(result);
        }),
    }),
  };
}

/** The tools' names, for the prompt and the activity labels (renderer/src/island.ts). */
export const COMPUTER_TOOL_NAMES = [
  "snapshot", "find", "read", "check_state", "screenshot", "list_apps", "list_windows", "click", "click_at", "type_text", "set_value", "clear", "focus",
  "select_option", "set_checked", "expand", "scroll", "scroll_to", "press_key", "open_app", "focus_window", "open_url", "close_app", "wait",
] as const;
