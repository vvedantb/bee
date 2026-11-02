import { z } from "zod";

// agent-desktop (npm, Apache-2.0) prints one JSON envelope per command: { version, ok: true, command, data } or
// { ok: false, error: { code, message, disposition } }. Pure parsing here; main/agent-desktop.ts runs the binary.
// Error messages and payloads can hold window titles and names, so only the error code is kept.

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

/** ok: the command's data. Otherwise a short code safe for logs (agent-desktop's own, or SPAWN_FAILED, TIMEOUT_LOCAL, BAD_OUTPUT). */
export type AgentDesktopResult = { ok: true; data: unknown } | { ok: false; code: string };

const envelopeSchema = z.union([
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) }),
]);

const safeCode = (code: string): string => (/^[A-Z][A-Z0-9_]{0,39}$/.test(code) ? code : "ERROR");

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
    return parsed.data.ok ? { ok: true, data: parsed.data.data } : { ok: false, code: safeCode(parsed.data.error.code) };
  }
  return { ok: false, code: "BAD_OUTPUT" };
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
  const holder = isRecord(data) && isRecord(data.permissions) ? data.permissions : data;
  const state = isRecord(holder) && isRecord(holder.accessibility) ? holder.accessibility.state : undefined;
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
