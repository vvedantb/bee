import { z } from "zod";

// agent-desktop (npm, Apache-2.0) prints one JSON envelope per command: { version, ok: true, command, data } or
// { ok: false, error: { code, message, disposition, details } }. Envelope 2.6 (agent-desktop 1.1). Pure parsing here;
// main/agent-desktop.ts runs the binary.
// Error messages can hold window titles and names: an error keeps its code, whether a retry is safe, and the message cut short
// with anything quoted, any path, link or address taken out (safeMessage).

/** The only commands Bee runs. Each one observes; none clicks, types, focuses or moves anything. */
export const READ_ONLY_COMMANDS = ["list-apps", "list-windows", "snapshot", "find", "get", "permissions", "status", "version"] as const;
export type ReadOnlyCommand = (typeof READ_ONLY_COMMANDS)[number];

// Flags that permit physical input, prompt, open System Settings, or write traces and screenshots to disk.
const BLOCKED_FLAGS = new Set(["--headed", "--request", "--guide", "--screenshot", "--debug", "--trace", "--trace-strict", "--wait-for", "-w", "--wait-for-gone", "--session"]);

/** Throws for any command or flag outside the read-only set. Called before every spawn. */
export function assertReadOnly(command: string, args: readonly string[]): asserts command is ReadOnlyCommand {
  if (!(READ_ONLY_COMMANDS as readonly string[]).includes(command)) throw new Error(`agent-desktop command not allowed: ${command}`);
  const blocked = args.find((arg) => BLOCKED_FLAGS.has(arg.split("=")[0] ?? arg));
  if (blocked) throw new Error(`agent-desktop flag not allowed: ${blocked}`);
}

/**
 * The only commands Bee's desktop tools run, for a direct request ("Bee, open Teams"): open or bring forward an app, and find
 * it. They run on their own runner (main/agent-desktop.ts), which the meeting window reader never gets. None
 * clicks, types, presses keys, sets the clipboard or closes anything.
 */
export const DESKTOP_ACTION_COMMANDS = ["launch", "focus-window", "list-apps", "list-windows"] as const;
export type DesktopActionCommand = (typeof DESKTOP_ACTION_COMMANDS)[number];

// The flags each action command may take (true: it takes a value). Anything else is refused, so launch never gets --arg, --env,
// --cwd, --cdp or --no-attach, and nothing gets --headed.
const ACTION_FLAGS: Record<DesktopActionCommand, Record<string, boolean>> = {
  launch: { "--activate": false, "--timeout": true },
  "focus-window": { "--app": true, "--title": true, "--window-id": true },
  "list-apps": { "--app": true, "--timeout-ms": true },
  "list-windows": { "--app": true, "--timeout-ms": true },
};
// launch takes the app name; the others take none.
const ACTION_POSITIONALS: Record<DesktopActionCommand, number> = { launch: 1, "focus-window": 0, "list-apps": 0, "list-windows": 0 };

/** Throws for any command, flag or argument outside the desktop action set. Called before every spawn on that runner. */
export function assertDesktopAction(command: string, args: readonly string[]): asserts command is DesktopActionCommand {
  if (!(DESKTOP_ACTION_COMMANDS as readonly string[]).includes(command)) throw new Error(`agent-desktop command not allowed: ${command}`);
  const flags = ACTION_FLAGS[command as DesktopActionCommand];
  let positionals = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!arg.startsWith("-")) {
      positionals += 1;
      continue;
    }
    if (!Object.hasOwn(flags, arg)) throw new Error(`agent-desktop flag not allowed: ${arg.split("=")[0]}`);
    if (!flags[arg]) continue;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("-")) throw new Error(`agent-desktop flag needs a value: ${arg}`);
    index += 1;
  }
  if (positionals !== ACTION_POSITIONALS[command as DesktopActionCommand]) throw new Error(`agent-desktop arguments not allowed for ${command}`);
}

/**
 * Computer use for a direct request ("Bee, send Sam a message in Slack", core/computer-use.ts): the commands the AI's computer
 * tools run, on their own runner (main/agent-desktop.ts createAgentDesktopComputerRunner). The meeting window reader never gets
 * it. Accessibility snapshots, refs and keys only: no screenshots, mouse, clipboard, notifications, drag, hover, batch, sessions,
 * traces or launch (apps open through the desktop actions).
 */
export const COMPUTER_USE_COMMANDS = [
  "snapshot", "find", "get", "is", "list-apps", "list-windows", "permissions",
  "click", "type", "set-value", "clear", "focus", "select", "check", "uncheck", "expand", "collapse", "scroll", "scroll-to", "press",
  "close-app", "wait",
] as const;
export type ComputerUseCommand = (typeof COMPUTER_USE_COMMANDS)[number];

/** agent-desktop's flag for physical input. Only press, type and focus may take it (assertComputerUse), when the AI asks. */
export const HEADED_FLAG = "--headed";

// What a flag value or positional may be. Value flags are always "--flag=value", so a value can never read as a flag.
type ValueKind = "ref" | "app" | "window" | "text" | "role" | "ms" | "count" | "keys" | readonly string[];
type CommandSpec = {
  /** Value flags (a kind) and bare switches (true). */
  flags: Record<string, ValueKind | true>;
  /** Positionals before "--", in order. min: how many may be left out from the end (wait's milliseconds). */
  positionals: readonly ValueKind[];
  min?: number;
  /** Free text after "--" (type, set-value, select): so text that starts with "-" is never a flag. */
  text?: true;
  /** May take HEADED_FLAG. */
  headed?: true;
};

const SURFACES = ["window", "focused", "menu", "menubar", "sheet", "popover", "alert"] as const;
const EVENTS = ["window-opened", "window-closed", "app-launched", "app-terminated", "focus-changed", "surface-appeared", "surface-dismissed"] as const;
const ACTION = { "--timeout-ms": "ms" } as const;
const SCOPE = { "--app": "app", "--window-id": "window", "--root": "ref", "--surface": SURFACES, "--timeout-ms": "ms" } as const;
const onRef = (extra: Partial<CommandSpec> = {}): CommandSpec => ({ flags: ACTION, positionals: ["ref"], ...extra });

const COMPUTER_SPECS: Record<ComputerUseCommand, CommandSpec> = {
  snapshot: { flags: { ...SCOPE, "--max-depth": "count", "--interactive-only": true, "--compact": true, "--skeleton": true }, positionals: [] },
  find: {
    flags: { ...SCOPE, "--role": "role", "--name": "text", "--text": "text", "--value": "text", "--description": "text", "--exact": true, "--first": true, "--limit": "count" },
    positionals: [],
  },
  get: { flags: { "--property": ["text", "value", "title", "role", "states"] }, positionals: ["ref"] },
  is: { flags: { "--property": ["visible", "enabled", "checked", "focused", "expanded", "selected"] }, positionals: ["ref"] },
  "list-apps": { flags: { "--app": "app", "--timeout-ms": "ms" }, positionals: [] },
  "list-windows": { flags: { "--app": "app", "--timeout-ms": "ms" }, positionals: [] },
  permissions: { flags: {}, positionals: [] },
  click: onRef(),
  type: onRef({ text: true, headed: true }),
  "set-value": onRef({ text: true }),
  clear: onRef(),
  focus: onRef({ headed: true }),
  select: onRef({ text: true }),
  check: onRef(),
  uncheck: onRef(),
  expand: onRef(),
  collapse: onRef(),
  scroll: onRef({ flags: { ...ACTION, "--direction": ["up", "down", "left", "right"], "--amount": "count" } }),
  "scroll-to": onRef(),
  // Never --force: agent-desktop refuses quit and lock shortcuts without it.
  press: { flags: { "--app": "app", "--window-id": "window" }, positionals: ["keys"], headed: true },
  // Never --force: the app quits gracefully, and agent-desktop refuses protected system processes.
  "close-app": { flags: {}, positionals: ["app"] },
  wait: { flags: { "--window": "text", "--text": "text", "--app": "app", "--event": EVENTS, "--timeout": "ms", "--menu": true, "--menu-closed": true }, positionals: ["ms"], min: 1 },
};

/** A ref as agent-desktop prints it: @<snapshot id>:e<N>. A bare @e8 is refused by agent-desktop too. */
export const REF_PATTERN = /^@[A-Za-z0-9]{1,40}:e\d{1,6}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
// Waits and timeouts: at most a minute.
const MAX_MS = 60_000;

function validValue(kind: ValueKind, value: string): boolean {
  if (Array.isArray(kind)) return kind.includes(value);
  switch (kind) {
    case "ref":
      return REF_PATTERN.test(value);
    case "app":
      return value.length > 0 && value.length <= 120 && !value.startsWith("-") && !/[\u0000-\u001f\u007f]/.test(value);
    case "window":
      return /^w-[A-Za-z0-9-]{1,40}$/.test(value);
    case "text":
      return value.length <= 4000 && !CONTROL.test(value);
    case "role":
      return /^[A-Za-z]{2,30}$/.test(value);
    case "ms":
      return /^\d{1,5}$/.test(value) && Number(value) <= MAX_MS;
    case "count":
      return /^\d{1,3}$/.test(value);
    case "keys":
      // return, cmd+w, ctrl+shift+tab: letters and digits joined by "+". Punctuation goes by name (comma, period).
      return value.length <= 40 && /^[A-Za-z0-9]{1,12}(?:\+[A-Za-z0-9]{1,12}){0,4}$/.test(value);
  }
  return false;
}

/**
 * Throws for any command, flag or argument outside the computer-use set. Called before every spawn on that runner. Value flags
 * must be "--flag=value"; free text must follow "--"; only press, type and focus may take HEADED_FLAG.
 */
export function assertComputerUse(command: string, args: readonly string[]): asserts command is ComputerUseCommand {
  if (!(COMPUTER_USE_COMMANDS as readonly string[]).includes(command)) throw new Error(`agent-desktop command not allowed: ${command}`);
  const spec = COMPUTER_SPECS[command as ComputerUseCommand];
  const dash = args.indexOf("--");
  const before = dash < 0 ? args : args.slice(0, dash);
  const after = dash < 0 ? [] : args.slice(dash + 1);
  const seen = new Set<string>();
  const positionals: string[] = [];
  for (const arg of before) {
    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    const [flag = "", ...rest] = arg.split("=");
    const value = rest.length > 0 ? rest.join("=") : null;
    if (seen.has(flag)) throw new Error(`agent-desktop flag repeated: ${flag}`);
    seen.add(flag);
    if (flag === HEADED_FLAG && spec.headed && value === null) continue;
    const kind = Object.hasOwn(spec.flags, flag) ? spec.flags[flag] : undefined;
    if (kind === undefined) throw new Error(`agent-desktop flag not allowed: ${flag}`);
    if (kind === true) {
      if (value !== null) throw new Error(`agent-desktop flag takes no value: ${flag}`);
      continue;
    }
    if (value === null || !validValue(kind, value)) throw new Error(`agent-desktop flag value not allowed: ${flag}`);
  }
  const fewest = spec.positionals.length - (spec.min ?? 0);
  if (positionals.length < fewest || positionals.length > spec.positionals.length) throw new Error(`agent-desktop arguments not allowed for ${command}`);
  positionals.forEach((value, index) => {
    const kind = spec.positionals[index];
    if (!kind || !validValue(kind, value)) throw new Error(`agent-desktop argument not allowed for ${command}`);
  });
  if (spec.text ? dash < 0 || after.length !== 1 || !validValue("text", after[0] ?? "") : dash >= 0) throw new Error(`agent-desktop text not allowed for ${command}`);
}

/**
 * A failed command: a short code safe for logs (agent-desktop's own, or SPAWN_FAILED, TIMEOUT_LOCAL, BAD_OUTPUT, ABORTED,
 * REFUSED); agent-desktop's message cut short and redacted (safeMessage); whether a retry is safe ("safe": it was never
 * delivered); its details.kind ("observation_incomplete", "identity_not_unique"); and retryable: false when agent-desktop
 * says waiting cannot change the outcome (details.retryable).
 */
export type AgentDesktopFailure = { ok: false; code: string; message?: string; retry?: string; kind?: string; retryable?: false };

/** ok: the command's data. */
export type AgentDesktopResult = { ok: true; data: unknown } | AgentDesktopFailure;

/**
 * A computer-use command on its own runner (main/agent-desktop.ts). signal: Stop or a newer request kills the command in
 * flight; a queued one never starts (ABORTED).
 */
export type ComputerRun = (command: ComputerUseCommand, args: string[], options?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<AgentDesktopResult>;

const envelopeSchema = z.union([
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.unknown().optional(), disposition: z.unknown().optional(), details: z.unknown().optional() }),
  }),
]);

const safeCode = (code: string): string => (/^[A-Z][A-Z0-9_]{0,39}$/.test(code) ? code : "ERROR");
/** A snake_case token ("safe", "observation_incomplete"), or undefined. */
const token = (value: unknown): string | undefined => (typeof value === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(value) ? value : undefined);
const field = (holder: unknown, key: string): unknown => (isRecord(holder) ? holder[key] : undefined);

/** How much of agent-desktop's message is kept. */
export const MESSAGE_MAX = 160;
// Quoted text (an app name, a window title, a ref): from a quote after a space or the start to the first quote before a space,
// punctuation or the end, so "app's" stays and "'Sam's chat'" goes whole.
const QUOTED = /(^|[\s(:=,[])["'`“‘].*?["'`”’](?=$|[\s),.:;!?\]])/g;
const PATH = /(?:[A-Za-z]:\\|\\\\|~?\/)[^\s'"`]*/g;
const LINK = /\b(?:https?|file):\/\/\S+/gi;
// A home folder (macOS /Users/<name>, Linux /home/<name>, Windows C:\Users\<name>, either slash) and what follows it. A user
// name can hold spaces, so the name runs to the next slash (or to the end, when none follows) and the rest of the path to a
// space, as PATH does.
const HOME = /(?:\b[A-Za-z]:)?[\\/](?:Users|home|Documents and Settings)[\\/][^\\/'"`\r\n]+(?:[\\/][^\s'"`]*)?/gi;
// A secret by its name (token=…, api_key: …, password=…), an Authorization value, and any long run of hex or base64 with a
// digit in it (a key, a session id).
const SECRET_PAIR = /\b([\w-]*(?:token|key|secret|password|passwd|pwd|credential|authorization)[\w-]*)\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi;
const BEARER = /\b(Bearer|Basic)\s+[\w.~+/=-]+/gi;
const LONG_TOKEN = /(?<![\w+/=-])(?=[\w+/=-]*\d)(?=[\w+/=-]*[A-Za-z])[\w+/-]{32,}={0,2}/g;
const EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;

/**
 * agent-desktop's error message, safe to log and to show the AI: one line, no control characters, anything quoted (names and
 * titles), any path (a home folder whole, with its user name), link, email address or secret replaced, cut to MESSAGE_MAX. Undefined when there is nothing left.
 */
export function safeMessage(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const line = raw
    .slice(0, 2000)
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ")
    .replace(LINK, "<link>")
    .replace(EMAIL, "<email>")
    .replace(HOME, "<path>")
    .replace(BEARER, "$1 <secret>")
    .replace(SECRET_PAIR, "$1=<secret>")
    .replace(QUOTED, "$1'…'")
    .replace(PATH, "<path>")
    .replace(LONG_TOKEN, "<secret>")
    .replace(/\s+/g, " ")
    .trim();
  if (!line) return undefined;
  return line.length > MESSAGE_MAX ? `${line.slice(0, MESSAGE_MAX - 1).trimEnd()}…` : line;
}

/** The envelope in stdout. One JSON document is expected; failing that, the last line that parses. */
export function parseEnvelope(stdout: string): AgentDesktopResult {
  const text = stdout.trim();
  const candidates = [text, ...text.split(/\r?\n/).reverse()];
  for (const candidate of candidates) {
    if (!candidate.startsWith("{")) continue;
    let json: unknown;
    try {
      json = JSON.parse(candidate);
    } catch {
      continue;
    }
    const parsed = envelopeSchema.safeParse(json);
    if (!parsed.success) continue;
    if (parsed.data.ok) return { ok: true, data: parsed.data.data };
    const { error } = parsed.data;
    const message = safeMessage(error.message);
    const retry = token(field(error.disposition, "retry"));
    const kind = token(field(error.details, "kind"));
    const final = field(error.details, "retryable") === false;
    return {
      ok: false,
      code: safeCode(error.code),
      ...(message ? { message } : {}),
      ...(retry ? { retry } : {}),
      ...(kind ? { kind } : {}),
      ...(final ? { retryable: false as const } : {}),
    };
  }
  return { ok: false, code: "BAD_OUTPUT" };
}

/**
 * A snapshot that could not read the whole window in time to prove its refs unique (data.identity_unproven, agent-desktop
 * 1.1). On Windows and Linux, and on macOS for an element with no address, its refs fail with AMBIGUOUS_TARGET
 * (identity_not_unique) until a snapshot with a larger --timeout-ms reads the window whole.
 */
export function identityUnproven(data: unknown): boolean {
  return isRecord(data) && data.identity_unproven === true;
}

export type AdApp = { name: string; pid: number | null; bundleId: string | null };
export type AdWindow = { id: string; title: string; app: string; pid: number | null; focused: boolean };
/** One accessibility node. Text fields are "" when absent. */
export type AdNode = { role: string; name: string; value: string; description: string; children: AdNode[] };
export type AccessState = "granted" | "denied" | "not_required" | "unknown";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const pid = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) ? value : null);

/** A list in `data`: the array itself, or `data[key]`. */
function listOf(data: unknown, key: string): unknown[] {
  if (Array.isArray(data)) return data;
  if (isRecord(data) && Array.isArray(data[key])) return data[key];
  return [];
}

/** list-apps: `{ name, pid, bundle_id, presentation }` rows. Rows without a name are dropped. */
export function parseApps(data: unknown): AdApp[] {
  return listOf(data, "apps").flatMap((item): AdApp[] => {
    if (!isRecord(item) || !text(item.name).trim()) return [];
    return [{ name: text(item.name).trim(), pid: pid(item.pid), bundleId: text(item.bundle_id) || null }];
  });
}

/** list-windows: `{ id, title, app_name, pid, bounds, is_focused, accessible }` rows. Rows without an id or app are dropped. */
export function parseWindows(data: unknown): AdWindow[] {
  return listOf(data, "windows").flatMap((item): AdWindow[] => {
    if (!isRecord(item)) return [];
    const id = typeof item.id === "number" ? String(item.id) : text(item.id);
    const app = text(item.app_name) || text(item.app) || (isRecord(item.app) ? text(item.app.name) : "");
    if (!id || !app.trim()) return [];
    return [{ id, title: text(item.title), app: app.trim(), pid: pid(item.pid), focused: item.is_focused === true }];
  });
}

/** Accessibility from `permissions` (data.accessibility) or `status` (data.permissions.accessibility). */
export function parseAccessibility(data: unknown): AccessState {
  return parsePermission(data, "accessibility");
}

/** One permission from `permissions` (data[name]) or `status` (data.permissions[name]): accessibility or screen_recording. */
export function parsePermission(data: unknown, name: "accessibility" | "screen_recording"): AccessState {
  const holder = isRecord(data) && isRecord(data.permissions) ? data.permissions : data;
  const entry = isRecord(holder) ? holder[name] : undefined;
  const state = isRecord(entry) ? entry.state : undefined;
  return state === "granted" || state === "denied" || state === "not_required" ? state : "unknown";
}

/** `find --count`: the number of matches, or null when the shape is not understood. */
export function parseFindCount(data: unknown): number | null {
  if (typeof data === "number") return data;
  if (!isRecord(data)) return null;
  for (const key of ["count", "match_count", "total"]) if (typeof data[key] === "number") return data[key];
  return Array.isArray(data.matches) ? data.matches.length : null;
}

// Bounds for a snapshot tree, so a huge or hostile reply cannot run away with memory or the stack.
const MAX_NODES = 20_000;
const MAX_DEPTH = 80;

/** snapshot: `data.tree` as plain nodes. Null when there is no tree. */
export function parseSnapshotTree(data: unknown): AdNode | null {
  let count = 0;
  const walk = (raw: unknown, depth: number): AdNode | null => {
    if (!isRecord(raw) || depth > MAX_DEPTH || count >= MAX_NODES) return null;
    count += 1;
    const children = Array.isArray(raw.children) ? raw.children.map((child) => walk(child, depth + 1)).filter((child) => child !== null) : [];
    return { role: text(raw.role), name: text(raw.name), value: text(raw.value), description: text(raw.description), children };
  };
  return isRecord(data) ? walk(data.tree, 0) : null;
}
