import { tool } from "ai";
import { z } from "zod";
import { HEADED_FLAG, REF_PATTERN, parseApps, parseWindows, type AgentDesktopResult, type ComputerRun, type ComputerUseCommand } from "./agent-desktop-envelope";
import { awaitAnswer, CONFIRM_TIMEOUT_MS, type ComputerPlatform, type IrreversibleKind, type RunControl } from "./computer-control";
import {
  EFFECTS, LABEL_MAX, WINDOW_ROLES, confirmDetail, confirmQuestion, focusAfterClick, insideOf, isNavField, isTextEntry, keepsFocus, keysLabel, needsConfirm,
  shellElement, shortName, type Effect, type Element, type GateAction, type TreeContext,
} from "./computer-gate";
import { APP_NAME_MAX, WINDOW_TITLE_MAX, appKey, isBlockedApp, type DesktopActionResult, type DesktopActions } from "./desktop-actions";
import { debugLog, msSince } from "./debug-log";
import type { LunaToolActivity } from "./luna";

// The AI's computer tools, for a direct request only ("Bee, send Sam a message in Discord"): never in a meeting tip turn. They
// read an app's accessibility tree and act on one element at a time through agent-desktop (main runs each command on its own
// runner with fixed argv and no shell; main/agent-desktop.ts assertComputerUse checks every one). Apps open, windows come forward
// and pages open through the desktop actions (core/desktop-actions.ts). Each call is one step of the run's budget
// (core/computer-control.ts); sending, deleting, buying and submitting wait for the user's Confirm first when the setting is on
// (core/computer-gate.ts, which reads where each ref sits in the tree, not just what the AI says). Terminals, script tools,
// system settings and Bee itself are never read or typed into.

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
// agent-desktop's own budgets, and Bee's kill timer a little above each.
const SNAPSHOT_TIMEOUT_MS = 8000;
const LOOK_MS = 15_000;
const ACT_MS = 12_000;
const WAIT_MAX_MS = 15_000;
// A screenshot as base64. Larger ones are refused rather than sent.
const SCREENSHOT_MAX_CHARS = 6_000_000;

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
};

/** A failed command as the AI sees it: the code (never agent-desktop's message, which can hold window text) and what to do. */
export function errorLine(code: string): string {
  return `Error ${code}: ${HINTS[code] ?? "that did not work. Look again before trying something else."}`;
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
 * when it says, and the element it shows focused.
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
  let focused: Element | null = null;

  // Text fields under a container, down to three levels, with the child each one is under. Remembered per container.
  const fieldMemo = new Map<unknown, FoundField[]>();
  const fieldsIn = (container: Record<string, unknown>, depth: number): FoundField[] => {
    let found = fieldMemo.get(container);
    if (!found) {
      const list: FoundField[] = [];
      const visit = (node: unknown, level: number, branch: unknown) => {
        if (list.length >= 20 || !isRecord(node)) return;
        const element = elementOf(node);
        if (isTextEntry(element)) list.push({ field: { role: element.role, name: element.name }, branch, depth: level });
        if (level < 3) for (const child of childrenOf(node)) visit(child, level + 1, branch);
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
        const label = isRecord(sibling) ? elementOf(sibling).name.replace(/\s+/g, " ").trim() : "";
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
    if (cut || !isRecord(raw) || depth > MAX_DEPTH) return;
    if (count >= MAX_NODES) {
      cut = true;
      return;
    }
    count += 1;
    const ref = str(raw.ref_id);
    if (ref && REF_PATTERN.test(ref)) {
      const element: Element = { ...elementOf(raw), context: contextOf(raw, place) };
      remember(ref, element);
      if (focusedNode(raw)) focused = element;
    }
    const line = elementLine(raw, depth);
    if (line) {
      if (size + line.length + 1 > max) {
        cut = true;
        return;
      }
      lines.push(line);
      size += line.length + 1;
    }
    const children = childrenOf(raw);
    const ancestors = children.length > 0 ? [asAncestor(elementOf(raw)), ...place.ancestors].slice(0, MAX_ANCESTORS) : [];
    children.forEach((child, index) => walk(child, line ? depth + 1 : depth, { parent: raw, grand: place.parent, siblings: children, index, ancestors }));
  };
  walk(tree, 0, { parent: null, grand: null, siblings: [], index: 0, ancestors: top.slice(0, MAX_ANCESTORS) });
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
  return matches
    .slice(0, FIND_LIMIT)
    .map((match) => {
      const ref = str(match.ref_id);
      if (ref && REF_PATTERN.test(ref)) remember(ref, elementOf(match));
      return elementLine(match, 0) ?? str(match.role);
    })
    .join("\n");
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
  let chain: Promise<unknown> = Promise.resolve();
  const remember = (ref: string, element: Element) => refs.set(ref, element);

  /** UI actions must not interleave: parallel tool calls run one after another, in the order the AI made them. */
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work);
    chain = next.catch(() => undefined);
    return next;
  };

  /** One agent-desktop command for this run. A permission refusal (other than Screen Recording) ends the run. */
  const exec = async (command: ComputerUseCommand, args: string[], timeoutMs: number): Promise<AgentDesktopResult> => {
    const started = performance.now();
    const result = await deps.run(command, args, { timeoutMs, signal: control.signal });
    debugLog.debug("computer", "exec", { command, args, ok: result.ok, code: result.ok ? null : result.code, ms: msSince(started) });
    if (!result.ok) {
      console.debug(`computer ${command} ${result.code}`);
      if (result.code === "PERM_DENIED" && command !== "screenshot") control.stop("permission");
    }
    return result;
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
  const done = (result: AgentDesktopResult) => (result.ok ? formatDone(result.data) : errorLine(result.code));
  const desktopLine = (result: DesktopActionResult) => (result.ok ? `Done: ${result.message}.` : `Error: ${result.message}.`);

  /** A ref action: check the ref, run it, and keep where focus is for Return. Never in a terminal or console. */
  const onRef = (command: ComputerUseCommand, ref: string, args: string[] = [], timeoutMs = ACT_MS) => async () => {
    if (["click", "type", "set-value", "clear", "focus"].includes(command) && shellElement(refs.get(ref))) return SHELL_MESSAGE;
    const result = await exec(command, [ref, ...args], timeoutMs);
    if (result.ok && ["type", "set-value", "clear", "focus"].includes(command)) lastField = refs.get(ref) ?? lastField;
    if (result.ok && command === "click") lastField = focusAfterClick(lastField, refs.get(ref));
    return done(result);
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
          const args = [
            "--interactive-only",
            "--compact",
            ...(input.root ? [`--root=${input.root}`] : scope(input)),
            ...(input.surface && !input.root ? [`--surface=${input.surface}`] : []),
            ...(input.skeleton && !input.surface && !input.root ? ["--skeleton"] : []),
            `--timeout-ms=${SNAPSHOT_TIMEOUT_MS}`,
          ];
          const result = await exec("snapshot", args, LOOK_MS);
          if (!result.ok) return errorLine(result.code);
          // Refs from an app Bee never uses are dropped before the AI sees them.
          const kept = new Map<string, Element>();
          const within = input.root ? refs.get(input.root) : undefined;
          const shown = formatSnapshot(result.data, (ref, item) => kept.set(ref, item), SNAPSHOT_CHARS, input.root && within ? { ref: input.root, element: within } : null);
          if (shown.app && offLimitsApp(shown.app)) return OFF_LIMITS_MESSAGE;
          for (const [ref, item] of kept) remember(ref, item);
          if (shown.focused) lastField = shown.focused;
          const shownWindow = isRecord(result.data) && isRecord(result.data.window) ? str(result.data.window.id) : "";
          if (/^w-[A-Za-z0-9-]{1,40}$/.test(shownWindow)) windows.add(shownWindow);
          currentApp = shown.app ?? (input.app ? cleanApp(input.app) : currentApp);
          return shown.text;
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
          const result = await exec("find", args, LOOK_MS);
          // A match keeps where it sits when a snapshot showed it, or sits inside root when one was given.
          const inside = insideOf(input.root ? refs.get(input.root) : null);
          const found = (ref: string, item: Element) => {
            const context = refs.get(ref)?.context ?? inside;
            remember(ref, context ? { ...item, context } : item);
          };
          return result.ok ? formatMatches(result.data, found) : errorLine(result.code);
        }),
    }),

    read: tool({
      description: "Read one property of a ref: text (what a person reads), value, title, role or states.",
      inputSchema: z.object({ ref: refSchema, property: z.enum(["text", "value", "title", "role", "states"]).optional() }),
      execute: ({ ref, property }) =>
        step("read", "Reading the screen…", async () => {
          const invalid = badRef(ref);
          if (invalid) return invalid;
          const result = await exec("get", [ref, `--property=${property ?? "text"}`], LOOK_MS);
          return result.ok ? formatRead(result.data) : errorLine(result.code);
        }),
    }),

    check_state: tool({
      description: "Check one state of a ref: visible, enabled, checked, focused, expanded or selected.",
      inputSchema: z.object({ ref: refSchema, property: z.enum(["visible", "enabled", "checked", "focused", "expanded", "selected"]) }),
      execute: ({ ref, property }) =>
        step("check_state", "Reading the screen…", async () => {
          const invalid = badRef(ref);
          if (invalid) return invalid;
          const result = await exec("is", [ref, `--property=${property}`], LOOK_MS);
          return result.ok ? formatRead(result.data) : errorLine(result.code);
        }),
    }),

    screenshot: tool({
      description: "A picture of one app's window, when the element list is not enough (a canvas, an image, a layout). Prefer snapshot: it gives refs.",
      inputSchema: z.object({ app: appSchema, window_id: windowSchema.optional() }),
      execute: (input) =>
        step("screenshot", `Looking at ${shortName(input.app, 30)}…`, async (): Promise<ScreenshotOutput> => {
          const invalid = badApp(input.app) ?? badWindow(input.window_id);
          if (invalid) return { text: invalid };
          const result = await exec("screenshot", scope(input), LOOK_MS);
          if (!result.ok) return { text: result.code === "PERM_DENIED" ? "Error PERM_DENIED: Screen Recording is off for Bee. Use snapshot instead." : errorLine(result.code) };
          const image = screenshotData(result.data);
          return image ? { text: `Screenshot of ${clip(input.app, 40)}.`, image } : { text: "Error: no picture came back. Use snapshot instead." };
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
          const result = await exec("list-apps", [], LOOK_MS);
          if (!result.ok) return errorLine(result.code);
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
          const result = await exec("list-windows", scope(input), LOOK_MS);
          if (!result.ok) return errorLine(result.code);
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
      description: "Type text into a text field, as keystrokes. A line break presses Return, which sends in most chat apps.",
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
            if (!keepsFocus(keys)) lastField = null;
            return result.ok ? `${formatDone(result.data)} Check the result with a snapshot.` : errorLine(result.code);
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
          return result.ok ? "Done." : errorLine(result.code);
        }),
    }),
  };
}

/** The tools' names, for the prompt and the activity labels (renderer/src/island.ts). */
export const COMPUTER_TOOL_NAMES = [
  "snapshot", "find", "read", "check_state", "screenshot", "list_apps", "list_windows", "click", "type_text", "set_value", "clear", "focus",
  "select_option", "set_checked", "expand", "scroll", "scroll_to", "press_key", "open_app", "focus_window", "open_url", "close_app", "wait",
] as const;
