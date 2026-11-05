import { tool } from "ai";
import { z } from "zod";
import {
  HEADED_FLAG, REF_PATTERN, identityUnproven, parseApps, parseWindows, type AgentDesktopFailure, type AgentDesktopResult, type ComputerRun, type ComputerUseCommand,
} from "./agent-desktop-envelope";
import { awaitAnswer, CONFIRM_TIMEOUT_MS, type ComputerPlatform, type IrreversibleKind, type RunControl } from "./computer-control";
import {
  EFFECTS, LABEL_MAX, WINDOW_ROLES, confirmDetail, confirmQuestion, focusAfterClick, insideOf, isNavField, isTextEntry, keepsFocus, keysLabel, needsConfirm, shellElement,
  shortName, type Effect, type Element, type GateAction, type TreeContext,
} from "./computer-gate";
import { APP_NAME_MAX, WINDOW_TITLE_MAX, appKey, isBlockedApp, type DesktopActionResult, type DesktopActions } from "./desktop-actions";
import { debugLog, errorData, msSince } from "./debug-log";
import type { LunaToolActivity } from "./luna";

// The AI's computer tools, for a direct request only ("Bee, send Sam a message in Discord"): never in a meeting tip turn. They
// follow agent-desktop's own loop: read an app's accessibility tree as a compact snapshot (or find one element), act on one
// element by its ref, read again to check. A small set, like agent-browser's: observe (snapshot, find, read), act on a ref
// (click, set_value, type_text, select_option, set_state, scroll, focus), keys, apps and waits. main runs each command on its
// own runner with fixed argv and no shell; main/agent-desktop.ts assertComputerUse checks every one. Apps open, windows come
// forward and pages open through the desktop actions (core/desktop-actions.ts). Each call is one step of the run's budget
// (core/computer-control.ts); sending, deleting, buying and submitting wait for the user's Confirm first when the setting is on
// (core/computer-gate.ts, which reads where each ref sits in the tree, not just what the AI says). Terminals, script tools,
// system settings and Bee itself are never read or typed into. The tree is the only way in: no screenshots and no clicks at a
// point. When an app's tree stays empty or unusable once Bee has waited for it and the AI has tried find, a skeleton and root
// (a canvas, an app that never exposes its controls), the tools tell the AI to stop and say Bee cannot control that app.

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

/** An app computer use never reads or types into. */
export function offLimitsApp(name: string): boolean {
  return isBlockedApp(name) || OFF_LIMITS.has(appKey(name));
}

const SHELL_MESSAGE = "Error: Bee does not type into terminals or consoles.";

// Overlays snapshot and find may read instead of the window, as each OS has them (agent-desktop status supported_surfaces).
// Since agent-desktop 1.1 a kind the OS does not have is INVALID_ARGS, so the AI is never offered one. Windows reads an open
// menu as menu and a Chromium modal (Teams, Edge) as sheet, and has no menubar.
const SURFACES = { mac: ["menu", "menubar", "sheet", "popover", "alert"], windows: ["menu", "sheet"] } as const satisfies Record<ComputerPlatform, readonly string[]>;
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
// the grown tree: a thin first read, or one that failed where a retry is safe, is read again once with more time. Bee waits
// here, inside one step, rather than leave the AI to loop on reads.
const LOOK_TIMEOUT_MS = 12_000;
const SETTLE_TIMEOUT_MS = 25_000;
// Bee's kill timer sits this far above agent-desktop's own budget: start-up, and a large tree's JSON.
const KILL_MARGIN_MS = 6000;
// A whole-window read is thin with fewer refs than THIN_REFS (a cold Chromium app shows little more than its title bar
// buttons), or when it ran out of budget (complete: false) with fewer than PARTIAL_REFS (a first read is about a thirteenth of
// the settled tree). It is shallow when its refs are almost all containers with more cut below them: Chromium nests its
// controls under long chains of unnamed groups, past the default depth. Either is read once more, and that read goes deeper.
// So is a read that could not prove its refs (identity_unproven), which a longer budget fixes.
const THIN_REFS = 4;
const PARTIAL_REFS = 20;
const DEEP_DEPTH = 25;
// Roles that only hold other elements. A ref on one of them is a region to drill into with root, not a control. A window's
// own buttons are no app control either: a cut-off Chromium window shows little else. A read is shallow with fewer than
// SHALLOW_CONTROLS app controls left above the cut.
const CONTAINER_ROLE = /^(?:group|pane|generic|section|region|document|webarea|web ?view|scroll ?area|window|application|panel|list|toolbar|unknown|element|custom|none|presentation)$/i;
const WINDOW_BUTTON = /^(?:minimi[sz]e|maximi[sz]e|restore(?: down)?|close|system menu)$/i;
const SHALLOW_CONTROLS = 2;
// Codes, and details.kind words, where a second read may succeed, when agent-desktop says a retry is safe (nothing was
// delivered) and does not say waiting cannot help (details.retryable: false).
const LOOK_AGAIN = new Set(["INTERNAL", "TIMEOUT", "APP_UNRESPONSIVE"]);
const LOOK_AGAIN_KIND = /renderer|activation|incomplete|settle/;
// get and is take no budget of their own: Bee's kill timer only.
const READ_MS = 15_000;
const ACT_MS = 12_000;
const WAIT_MAX_MS = 15_000;

/**
 * What the AI is told to do when the tree gives it nothing to act on, once Bee has waited and the AI has tried find, a skeleton
 * and root. Bee has no screenshots or clicks at a point to fall back on, so it says so plainly.
 */
export const CANNOT_CONTROL = "stop and say Bee cannot control this app";
const KEEPS_FAILING = `If it keeps failing, ${CANNOT_CONTROL}.`;

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
  INTERNAL: `agent-desktop hit an unexpected error in this app. Look again once. For a busy app take a skeleton snapshot, then root one region. ${KEEPS_FAILING}`,
  BAD_OUTPUT: `agent-desktop gave no answer Bee could read. Look again once. ${KEEPS_FAILING}`,
  SPAWN_FAILED: "Bee could not start its desktop helper. Stop and say so.",
  REFUSED: "Bee does not run that. Check the ref, app name, window id and other arguments.",
};
// Looking (snapshot, find, read, check_state, list_apps, list_windows) changes nothing, so a timeout or no answer means the
// app's tree is slow or broken, not that something may have happened.
const LOOK_HINTS: Record<string, string> = {
  TIMEOUT: `the app's tree did not finish in time. Take a skeleton snapshot, then root one region, or find by role. If the app just opened, wait and look again. ${KEEPS_FAILING}`,
  TIMEOUT_LOCAL: `the app's tree took too long. Take a skeleton snapshot, then root one region. ${KEEPS_FAILING}`,
  APP_UNRESPONSIVE: `the app did not answer. Wait, then look again. ${KEEPS_FAILING}`,
  INVALID_ARGS: "check the ref and the arguments: refs come only from the latest snapshot or find, and a surface must be one this computer has.",
};
// agent-desktop 1.1's details.kind, where it says more than the code. Refs prove their identity: on Windows (and on macOS for
// an element with no address) a ref acts only when it was the only element in its window with its role, name and
// description.
const KIND_HINTS: Record<string, string> = {
  identity_not_unique:
    "this element has an identical twin in the window, so it cannot be used by ref. Act on a control that is unique in the window: find it by name, or root into its row. If there is none, stop and say Bee cannot tell which one to use.",
  saved_ref_ambiguous: "an identical element appeared since the snapshot. Take a new snapshot, and act on a control that is unique in the window.",
  resolution_identity_unknown: "agent-desktop could not check the element in time, so nothing was done. Look again, then try once more.",
  post_action_verification: "it happened, but the element now reads differently (the app may have reformatted it). Read it before writing again. Never repeat a send or delete blindly.",
  actionability_timeout: "the element never became ready: it may be disabled, hidden or covered. Check it with read, or take a new snapshot.",
  scroll_into_view_unsupported: "the element is out of view and cannot scroll itself. Scroll the area around it with scroll, then try again.",
  live_read_incomplete: "the app did not answer for that element. Take a new snapshot and use its refs.",
};
const MAY_HAVE_HAPPENED = "It may still have happened: look before trying again.";
const NOT_DELIVERED = "nothing was done (agent-desktop says it was not delivered). Look again, then try once more or another way.";
const FINAL = " Waiting will not help: try another way.";

/**
 * A failed command as the AI sees it: the code, what to do, and agent-desktop's own message when it gave one (cut short and with
 * names, titles and paths taken out: core/agent-desktop-envelope.ts safeMessage). look: an observation, which changes nothing.
 * An action agent-desktop does not call safe to retry may still have happened; one it calls safe (not delivered) did not.
 */
export function errorLine(failure: string | AgentDesktopFailure, look = false): string {
  const { code, message, retry, kind, retryable } = typeof failure === "string" ? ({ code: failure } as Partial<AgentDesktopFailure> & { code: string }) : failure;
  const byKind = kind && Object.hasOwn(KIND_HINTS, kind) ? KIND_HINTS[kind] : undefined;
  let hint = byKind ?? (look ? LOOK_HINTS[code] : undefined) ?? HINTS[code] ?? "that did not work. Look again before trying something else.";
  if (!look && !byKind && retry === "safe" && hint.includes("may still have happened")) hint = NOT_DELIVERED;
  // A hint that already says whether it happened needs no second word on it.
  const says = hint.includes("may still have happened") || kind === "post_action_verification";
  const unsafe = !look && retry !== undefined && retry !== "safe" && !says ? ` ${MAY_HAVE_HAPPENED}` : "";
  return `Error ${code}: ${hint}${unsafe}${retryable === false ? FINAL : ""}${message ? ` Detail: ${message}` : ""}`;
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
  const isRef = !!within && !!tree && str(tree.ref_id) === within.ref;
  const top = isRef ? above : within ? [asAncestor(within.element), ...above] : [];
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
      // The region's top is the ref itself: name it as Bee saw it first, since a region often comes back unnamed.
      const self = isRef && raw === tree && within ? within.element : elementOf(raw);
      ancestors = children.length > 0 ? [asAncestor(self), ...place.ancestors].slice(0, MAX_ANCESTORS) : [];
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

/**
 * A settled window read cut off by depth (Chromium's long chains of unnamed groups): refs, but next to no app controls (a
 * window's own buttons do not count), and branches cut below with more inside. Read deeper, or drill one region with root.
 */
export function shallowTree(data: unknown): boolean {
  const { controls, cut } = walkRefs(data);
  return cut && controls < SHALLOW_CONTROLS;
}

/** How many refs a snapshot holds: its ref_count, else counted in its tree (up to 5000 nodes). */
export function refCount(data: unknown): number {
  if (!isRecord(data)) return 0;
  if (typeof data.ref_count === "number" && Number.isFinite(data.ref_count)) return data.ref_count;
  return walkRefs(data).refs;
}

/** A snapshot tree's refs (up to 5000 nodes): all of them, those on controls rather than containers, and whether a branch was cut. */
function walkRefs(data: unknown): { refs: number; controls: number; cut: boolean } {
  let [refs, controls, cut, seen] = [0, 0, false, 0];
  const stack: unknown[] = [isRecord(data) ? data.tree : null];
  while (stack.length > 0 && seen < 5000) {
    const node = stack.pop();
    seen += 1;
    try {
      if (!isRecord(node)) continue;
      if (typeof node.ref_id === "string" && REF_PATTERN.test(node.ref_id)) {
        refs += 1;
        if (!CONTAINER_ROLE.test(str(node.role)) && !WINDOW_BUTTON.test(str(node.name).trim())) controls += 1;
      }
      if ((typeof node.children_count === "number" && node.children_count > 0) || node.subtree_truncated === true) cut = true;
      if (Array.isArray(node.children)) for (const child of node.children.slice(0, 5000)) stack.push(child);
    } catch {
      // Not counted.
    }
  }
  return { refs, controls, cut };
}

/**
 * A successful action: how it was delivered, the element as agent-desktop read it back after (post_state: its value and
 * states, so the AI need not look again just to check), and any menu, sheet or alert it left open.
 */
export function formatDone(data: unknown): string {
  const record = isRecord(data) ? data : {};
  const disposition = isRecord(record.disposition) ? str(record.disposition.delivery) : "";
  const surfaces = Array.isArray(record.surfaces)
    ? record.surfaces.map((surface) => (isRecord(surface) ? str(surface.kind) || str(surface.surface) || str(surface.type) : str(surface))).filter(Boolean)
    : [];
  return [
    `Done${disposition ? ` (${disposition})` : ""}.`,
    postState(record.post_state),
    surfaces.length > 0 ? ` Open now: ${[...new Set(surfaces)].slice(0, 5).join(", ")}. Act on it next: snapshot with that surface.` : "",
  ].join("");
}

const POST_FLAGS = ["checked", "expanded", "selected", "focused", "enabled"] as const;

/** post_state as " Now: value="…" [checked]." , or "" when agent-desktop read nothing back Bee understands. */
function postState(raw: unknown): string {
  if (!isRecord(raw)) return "";
  try {
    const value = typeof raw.value === "string" ? ` value=${quoted(raw.value)}` : "";
    const states = Array.isArray(raw.states) ? raw.states.filter((state): state is string => typeof state === "string" && /^[a-z_]{1,24}$/.test(state)) : [];
    for (const flag of POST_FLAGS) if (typeof raw[flag] === "boolean" && !states.includes(flag)) states.push(raw[flag] ? flag : `not ${flag}`);
    const shown = states.slice(0, 6);
    return value || shown.length > 0 ? ` Now:${value}${shown.length > 0 ? ` [${shown.join(", ")}]` : ""}.` : "";
  } catch {
    return "";
  }
}

/** get and is: the answer as short JSON. */
const formatRead = (data: unknown) => clip(JSON.stringify(data ?? null) ?? "null", 1500);

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
  .describe(
    "What this action commits: send (it sends a message, email or post, including Return in a chat box), delete (it deletes something), buy (it pays or places an order), submit (it submits a form that commits something). Otherwise none: navigating, tabs, menus, opening apps, and Continue, Next or OK that commit nothing.",
  );
const physicalSchema = z
  .boolean()
  .optional()
  .describe("Real key presses or focus. Only when POLICY_DENIED said this step needs it, or the system says this computer always needs it. Never to retry other errors.");

// read: get's properties, then is's true-or-false checks.
const GET_PROPERTIES = ["text", "value", "title", "role", "states"] as const;
const IS_PROPERTIES = ["visible", "enabled", "checked", "focused", "expanded", "selected"] as const;
// set_state: the agent-desktop command for each state, and the island's step line.
const STATE_ACTIONS = {
  checked: { command: "check", verb: "Ticking", line: "Ticking a box…" },
  unchecked: { command: "uncheck", verb: "Unticking", line: "Unticking a box…" },
  expanded: { command: "expand", verb: "Expanding", line: "Expanding…" },
  collapsed: { command: "collapse", verb: "Collapsing", line: "Collapsing…" },
} as const satisfies Record<string, { command: ComputerUseCommand; verb: string; line: string }>;

const UNREADABLE = `Error: Bee could not read that snapshot. Take a skeleton snapshot, then root one region, or use find. If those fail too, ${CANNOT_CONTROL}.`;
// What a whole-window read says when Bee's second read did not fix it. Bee has already waited for the app by then, so the AI
// tries the tree another way, then stops: there is no other way in.
const THIN_NOTE = `Few elements came back, though Bee gave the app time to load. Try find by role (textfield, button) or name, or a skeleton snapshot then root. If those show nothing usable either, ${CANNOT_CONTROL}.`;
const SHALLOW_NOTE = `The controls sit deeper than this read: snapshot one region marked inside with root, or use find by role or name. If those show no usable controls, ${CANNOT_CONTROL}.`;
const UNPROVEN_NOTE = `Bee could not read the whole window in time, so some refs may be refused (AMBIGUOUS_TARGET). If one is, snapshot again or use find. If they keep being refused, ${CANNOT_CONTROL}.`;

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
  // The app the run last read or acted in, for the Confirm prompt's detail.
  let currentApp: string | null = null;
  const surfaceSchema = z.enum(SURFACES[deps.platform]);
  let chain: Promise<unknown> = Promise.resolve();
  const remember = (ref: string, element: Element) => refs.set(ref, element);

  /** UI actions must not interleave: parallel tool calls run one after another, in the order the AI made them. */
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work);
    chain = next.catch(() => undefined);
    return next;
  };

  /**
   * One agent-desktop command for this run. A permission refusal ends the run. A failure is logged
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
      if (result.code === "PERM_DENIED") control.stop("permission");
    }
    return result;
  };

  /** A failed read that a second one may fix: agent-desktop says nothing was delivered, so a retry is safe. */
  const lookAgain = (result: AgentDesktopResult) =>
    !result.ok &&
    (LOOK_AGAIN.has(result.code) || LOOK_AGAIN_KIND.test(result.kind ?? "")) &&
    result.retry === "safe" &&
    result.retryable !== false &&
    !control.reason();

  /**
   * snapshot or find, read again once in a new process with the longer budget (args(budget, again)) when the first read failed
   * where a retry is safe, or settle(data) gives a reason to (thin, shallow, unproven). A first read still beats a failed
   * second one, and a second read with fewer app controls (a deeper read can drop the refs of the regions it no longer cuts),
   * unless only the second proved its refs.
   */
  const observe = async (command: "snapshot" | "find", args: (budget: number, again: boolean) => string[], settle?: (data: unknown) => string | null): Promise<AgentDesktopResult> => {
    const first = await exec(command, args(LOOK_TIMEOUT_MS, false), LOOK_TIMEOUT_MS + KILL_MARGIN_MS);
    const why = first.ok ? (control.reason() ? null : (settle?.(first.data) ?? null)) : lookAgain(first) ? first.code : null;
    if (!why) return first;
    debugLog.info("computer", "look-again", { command, why, refs: first.ok ? refCount(first.data) : null });
    deps.onStep?.("Waiting for the app…");
    const second = await exec(command, args(SETTLE_TIMEOUT_MS, true), SETTLE_TIMEOUT_MS + KILL_MARGIN_MS);
    if (!first.ok || !second.ok) return first.ok ? first : second;
    const [before, after] = [unproven(first.data), unproven(second.data)];
    if (before !== after) return before ? second : first;
    return walkRefs(second.data).controls < walkRefs(first.data).controls ? first : second;
  };

  // On a Mac each ref carries its element's own address, so a snapshot that could not prove its refs still acts. On Windows
  // its refs are refused (identity_not_unique) until a read with more time proves them.
  const unproven = (data: unknown) => deps.platform === "windows" && identityUnproven(data);

  /** Why a whole-window snapshot should be read once more: few refs, cut off by depth (not a skeleton), or refs not proven. */
  const settleWindow = (skeleton: boolean) => (data: unknown): string | null =>
    thinTree(data) ? "thin" : !skeleton && shallowTree(data) ? "shallow" : unproven(data) ? "unproven" : null;

  /** get or is, once more when a retry is safe. */
  const readOnce = async (command: "get" | "is", args: string[]): Promise<AgentDesktopResult> => {
    const first = await exec(command, args, READ_MS);
    return lookAgain(first) ? exec(command, args, READ_MS) : first;
  };

  /**
   * Runs one tool step: counts it, shows its line, asks first when the gate says so, then does the work. A step after the run
   * stopped does nothing.
   */
  const step = (name: string, label: string, work: () => Promise<string>, gate?: () => GateAction): Promise<string> =>
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

  /**
   * A ref action: check the ref, run it, and keep where focus is for Return. Never in a terminal or console. Once more when
   * agent-desktop could not check the element in time and says nothing was sent (resolution_identity_unknown).
   */
  const onRef = (command: ComputerUseCommand, ref: string, args: string[] = [], timeoutMs = ACT_MS) => async () => {
    if (["click", "type", "set-value", "clear", "focus"].includes(command) && shellElement(refs.get(ref))) return SHELL_MESSAGE;
    let result = await exec(command, [ref, ...args], timeoutMs);
    if (!result.ok && result.kind === "resolution_identity_unknown" && result.retry === "safe" && !control.reason()) {
      debugLog.info("computer", "act-again", { command, kind: result.kind });
      result = await exec(command, [ref, ...args], timeoutMs);
    }
    if (result.ok && ["type", "set-value", "clear", "focus"].includes(command)) lastField = refs.get(ref) ?? lastField;
    if (result.ok && command === "click") lastField = focusAfterClick(lastField, refs.get(ref));
    return done(result);
  };

  const gateFor = (command: string, ref: string, extra: Partial<GateAction> & { effect?: Effect }) => (): GateAction => ({ command, target: refs.get(ref) ?? null, lastField, ...extra });

  return {
    snapshot: tool({
      description:
        "The main way to see an app: its window as a compact list of elements, each one you can act on with a ref (@s8f3k2p9:e12). Call it before acting, and after anything changes (root the same region to check). For a busy app (Slack, Teams, Discord, Chrome, Outlook) use skeleton first, then root to read one region.",
      inputSchema: z.object({
        app: appSchema.optional().describe("The app to read. Needed unless root is given."),
        window_id: windowSchema.optional(),
        root: refSchema.optional().describe("A ref from this task's snapshots: read only that region."),
        surface: surfaceSchema.optional().describe("An open menu or dialog to read instead of the window, when an action said one is open."),
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
          const result = await observe("snapshot", args, whole ? settleWindow(skeleton) : undefined);
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
          const notes = whole
            ? [
                thinTree(result.data) ? THIN_NOTE : !skeleton && shallowTree(result.data) ? SHALLOW_NOTE : null,
                unproven(result.data) ? UNPROVEN_NOTE : null,
              ].filter((note) => note !== null)
            : [];
          return [shown.text, ...notes].join("\n");
        }),
    }),

    find: tool({
      description:
        "Find elements in an app by role (button, textfield, link, tab…) and name or text, with refs. The fastest look when you know what you want; it also reaches controls a snapshot cuts off.",
      inputSchema: z.object({
        app: appSchema.optional().describe("The app to search. Needed unless root is given."),
        window_id: windowSchema.optional(),
        root: refSchema.optional().describe("Search only inside this ref's region."),
        surface: surfaceSchema.optional(),
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
      description:
        "Read one thing about a ref: text (what a person reads), value, title, role or states; or check one state, true or false: visible, enabled, checked, focused, expanded or selected.",
      inputSchema: z.object({ ref: refSchema, property: z.enum([...GET_PROPERTIES, ...IS_PROPERTIES]).optional() }),
      execute: ({ ref, property }) =>
        step("read", "Reading the screen…", async () => {
          const invalid = badRef(ref);
          if (invalid) return invalid;
          const args = [ref, `--property=${property ?? "text"}`];
          const result = (IS_PROPERTIES as readonly string[]).includes(property ?? "") ? await readOnce("is", args) : await readOnce("get", args);
          return result.ok ? formatRead(result.data) : errorLine(result, true);
        }),
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

    type_text: tool({
      description: "Type text into the text field with this ref, as keystrokes. A line break presses Return, which sends in most chat apps.",
      inputSchema: z.object({ ref: refSchema, text: z.string().min(1).max(4000), effect: effectSchema, physical: physicalSchema }),
      execute: ({ ref, text, effect, physical }) =>
        step(
          "type_text",
          label(ref, "Typing in", "Typing…"),
          async () => badRef(ref) ?? onRef("type", ref, [...(physical ? [HEADED_FLAG] : []), "--", cleanText(text)], ACT_MS + Math.min(40_000, text.length * 40))(),
          gateFor("type", ref, { effect, text }),
        ),
    }),

    set_value: tool({
      description: "Fill a text field: set its whole value at once; an empty value clears it. Faster than type_text and headless; use it for drafts, searches and form fields.",
      inputSchema: z.object({ ref: refSchema, value: z.string().max(4000), effect: effectSchema }),
      execute: ({ ref, value, effect }) =>
        value === ""
          ? step("set_value", label(ref, "Clearing", "Clearing a field…"), async () => badRef(ref) ?? onRef("clear", ref)(), gateFor("clear", ref, { effect }))
          : step(
              "set_value",
              label(ref, "Typing in", "Typing…"),
              async () => badRef(ref) ?? onRef("set-value", ref, ["--", cleanText(value)])(),
              gateFor("set-value", ref, { effect, text: value }),
            ),
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

    set_state: tool({
      description: "Tick or untick a checkbox or switch (checked, unchecked), or open or close a disclosure, tree item or section (expanded, collapsed).",
      inputSchema: z.object({ ref: refSchema, state: z.enum(["checked", "unchecked", "expanded", "collapsed"]) }),
      execute: ({ ref, state }) => {
        const { command, verb, line } = STATE_ACTIONS[state];
        return step("set_state", label(ref, verb, line), async () => badRef(ref) ?? onRef(command, ref)());
      },
    }),

    scroll: tool({
      description: "Scroll a scroll area (its ref) up, down, left or right. Without direction, scroll until the element with this ref is in view.",
      inputSchema: z.object({ ref: refSchema, direction: z.enum(["up", "down", "left", "right"]).optional(), amount: z.number().int().min(1).max(20).optional() }),
      execute: ({ ref, direction, amount }) =>
        step(
          "scroll",
          "Scrolling…",
          async () => badRef(ref) ?? (direction ? onRef("scroll", ref, [`--direction=${direction}`, `--amount=${amount ?? 3}`]) : onRef("scroll-to", ref))(),
        ),
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
            if (!keepsFocus(keys)) lastField = null;
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
          if (result.ok) [currentApp, lastField] = [name, null];
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
          if (result.ok) [currentApp, lastField] = [app, null];
          return desktopLine(result);
        }),
    }),

    open_url: tool({
      description: "Open a web page in the default browser, by its full https URL.",
      inputSchema: z.object({ url: z.string().min(1).max(2000) }),
      execute: ({ url }) =>
        step("open_url", "Opening the link…", async () => {
          const result = await deps.desktop.openUrl(url);
          if (result.ok) lastField = null;
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
          if (result.ok) lastField = null;
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
  "snapshot", "find", "read", "list_apps", "list_windows", "click", "type_text", "set_value", "focus", "select_option", "set_state", "scroll", "press_key",
  "open_app", "focus_window", "open_url", "close_app", "wait",
] as const;
