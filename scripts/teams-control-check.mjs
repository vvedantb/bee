// Developer-only diagnostic: which step of driving Microsoft Teams through agent-desktop fails on this machine.
// Run from a repo checkout: `npm run check:teams` or `node scripts/teams-control-check.mjs [--json] [--verbose] [--keep]
// [--skip-launch] [--timeout-ms N] [--app NAME]`. Not part of the release: electron-builder packs only out/**, resources/**
// and package.json (build.files), so scripts/ never ships.
//
// Safety: it never sends a message. Every agent-desktop call goes through guardCommand, which refuses any Return/Enter key,
// any click on a control named Send, any text other than the marker "bee-check", and every command outside a short allowlist.
// A self-test of the guard runs before the first command. It writes the marker into an empty compose box only, and clears it.
// Privacy: default output holds counts, roles, codes and process names. No message text, chat names or window titles;
// --verbose adds names and error messages.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MARKER = "bee-check";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------- Pure helpers (tested in teams-control-check.test.mjs) ----------

/** The agent-desktop file name in node_modules/agent-desktop/bin for this OS and CPU. Null where none ships. */
export function binaryName(platform, arch) {
  if (arch !== "x64" && arch !== "arm64") return null;
  if (platform === "darwin") return `agent-desktop-darwin-${arch}`;
  if (platform === "win32") return `agent-desktop-win32-${arch}.exe`;
  if (platform === "linux") return `agent-desktop-linux-${arch}`;
  return null;
}

/** AGENT_DESKTOP_PATH wins; else the bundled binary under root. Returns { path, source } or { error }. */
export function resolveBinary({ env, platform, arch, root, exists }) {
  const override = env.AGENT_DESKTOP_PATH;
  if (override) return exists(override) ? { path: override, source: "AGENT_DESKTOP_PATH" } : { error: `AGENT_DESKTOP_PATH does not exist: ${override}` };
  const name = binaryName(platform, arch);
  if (!name) return { error: `no agent-desktop binary ships for ${platform}-${arch}` };
  const path = join(root, "node_modules", "agent-desktop", "bin", name);
  return exists(path) ? { path, source: "node_modules" } : { error: `missing ${path}; run npm install` };
}

/** Width and height from a PNG's IHDR chunk, or null when the bytes are not a PNG. */
export function pngSize(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!bytes || bytes.length < 24 || signature.some((byte, i) => bytes[i] !== byte)) return null;
  if (bytes.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const ENTER_KEYS = new Set(["return", "enter", "kp_enter", "kpenter", "kp-enter", "numpadenter", "numpad_enter", "linefeed", "\n", "\r"]);
/** Whether a key combo holds Return or Enter in any form (ctrl+return, shift+Enter, KP_Enter ...). */
export const isEnterCombo = (combo) => String(combo).toLowerCase().split("+").some((key) => ENTER_KEYS.has(key.trim()));

const SEND_NAME = /\b(send|senden|envoyer|enviar|invia|verzenden|wyślij|odeslat)\b/i;
const ALLOWED = new Set([
  "version", "status", "permissions", "list-apps", "launch", "list-windows", "list-displays", "focus-window", "snapshot", "find",
  "get", "is", "click", "focus", "press", "set-value", "clear", "type", "clipboard-get", "clipboard-set", "clipboard-clear",
  "screenshot", "mouse-move",
]);
const GLOBAL_FLAGS = new Set(["--headed", "-v", "--verbose"]);

/** Positional arguments after the command (flags and their values skipped for the flags this script passes). */
function positionals(rest) {
  const VALUED = new Set(["--app", "--window-id", "--role", "--name", "--state", "--limit", "--timeout-ms", "--timeout", "--property", "--format", "--max-depth", "--title", "--out", "--xy"]);
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (VALUED.has(arg)) i++;
    else if (!arg.startsWith("-")) out.push(arg);
  }
  return out;
}

/**
 * Null when the argv is safe to run, else why it is refused. Refuses: commands outside the allowlist, Return/Enter in any
 * press (always, and above all while the compose box is focused), a click on a ref named Send, text other than the marker,
 * and any text with a line break. ctx: { composeFocused: boolean, refNames: Map<ref, name> }.
 */
export function guardCommand(argv, ctx) {
  let i = 0;
  while (i < argv.length && GLOBAL_FLAGS.has(argv[i])) i++;
  const command = argv[i];
  const rest = argv.slice(i + 1);
  if (!ALLOWED.has(command)) return `command "${command}" is not allowed in this check`;
  const args = positionals(rest);
  if (command === "press") {
    if (isEnterCombo(args[0] ?? "")) return ctx.composeFocused ? "Return/Enter refused: compose box is focused" : "Return/Enter refused: this check never presses it";
    return null;
  }
  if (command === "click" && SEND_NAME.test(ctx.refNames.get(args[0]) ?? "")) return "click refused: target is named like Send";
  if (command === "type" || command === "set-value") {
    if (rest.includes("--stdin")) return `${command} --stdin refused: only the marker may be written`;
    if (args[1] !== MARKER) return `${command} refused: only "${MARKER}" may be written`;
  }
  if (command === "clipboard-set" && !rest.includes("--stdin") && args[0] !== MARKER) return `clipboard-set refused: only "${MARKER}" or a --stdin restore`;
  if (rest.some((arg) => /[\r\n]/.test(arg))) return "refused: an argument holds a line break";
  return null;
}

/** Runs guardCommand on known bad and good commands. Returns the cases that did not behave, [] when all did. */
export function guardSelfTest() {
  const refNames = new Map([["@s1:e1", "Send"], ["@s1:e2", "Type a message"], ["@s1:e3", "Chat item"]]);
  const focused = { composeFocused: true, refNames };
  const idle = { composeFocused: false, refNames };
  const refuse = [
    [["press", "return"], focused],
    [["--headed", "press", "Enter", "--app", "ms-teams"], focused],
    [["press", "ctrl+return"], focused],
    [["press", "shift+enter"], focused],
    [["press", "KP_Enter"], focused],
    [["press", "return"], idle],
    [["click", "@s1:e1"], idle],
    [["type", "@s1:e2", "hello"], focused],
    [["type", "@s1:e2", `${MARKER}\n`], focused],
    [["set-value", "@s1:e2", "--stdin"], focused],
    [["clipboard-set", "other text"], idle],
    [["batch", "[]"], idle],
    [["mouse-click", "--xy", "1,1"], idle],
  ];
  const allow = [
    [["press", "ctrl+e", "--app", "ms-teams"], idle],
    [["--headed", "press", "escape", "--app", "ms-teams"], focused],
    [["--headed", "press", "ctrl+v", "--app", "ms-teams"], focused],
    [["--headed", "type", "@s1:e2", MARKER], focused],
    [["set-value", "@s1:e2", MARKER], focused],
    [["click", "@s1:e3"], idle],
    [["clipboard-set", "--stdin"], idle],
    [["snapshot", "--app", "ms-teams", "--skeleton", "-i", "--compact"], idle],
  ];
  const bad = [];
  for (const [argv, ctx] of refuse) if (guardCommand(argv, ctx) === null) bad.push(`allowed: ${argv.join(" ")}`);
  for (const [argv, ctx] of allow) if (guardCommand(argv, ctx) !== null) bad.push(`refused: ${argv.join(" ")}`);
  return bad;
}

/** A window title reduced to a class with no names: "chat/3+teams", "main/1+teams", "other/2+teams". */
export function titleClass(title) {
  if (typeof title !== "string" || !title.trim()) return "empty";
  const parts = title.split("|").map((part) => part.trim()).filter(Boolean);
  const teams = /microsoft\s+teams/i.test(parts.at(-1) ?? "");
  const head = (parts[0] ?? "").toLowerCase();
  let kind = "other";
  if (parts.length === 1 && teams) kind = "main";
  else if (["chat", "calendar", "activity", "teams", "calls", "files", "apps", "onedrive", "communities"].includes(head)) kind = head;
  else if (/\b(meeting|call|meet now)\b/.test(head)) kind = "meeting";
  return `${kind}/${parts.length}${teams ? "+teams" : ""}`;
}

/** Whether a list-apps row is Teams: new (ms-teams.exe), classic (Teams.exe), macOS or teams-for-linux. */
export function isTeamsApp(app) {
  const name = String(app?.name ?? "").trim();
  if (/^(?:microsoft\s+teams(?:\s+classic|\s*\((?:work or school|personal)\))?|ms[\s-]?teams|msteams|teams|teams-for-linux)(?:\.exe)?$/i.test(name)) return true;
  return /^com\.microsoft\.teams2?$/i.test(String(app?.bundle_id ?? ""));
}

/** The agent-desktop JSON envelope from stdout (the last JSON line if stray lines came first), or null. */
export function parseEnvelope(stdout) {
  const text = String(stdout).trim();
  for (const candidate of [text, ...text.split(/\r?\n/).reverse()]) {
    if (!candidate.startsWith("{")) continue;
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value.ok === "boolean") return value;
    } catch {
      // not this line
    }
  }
  return null;
}

const EDIT_ROLES = new Set(["textfield", "textarea", "textbox", "searchfield", "edit", "entry", "combobox", "document"]);
const LIST_ROLES = new Set(["treeitem", "listitem", "tree", "list"]);
export const SEARCH_NAME = /search|such|recherch|busc|cerca|zoek|szuk|hledat|pesquis/i;

/** Counts from a snapshot tree: nodes, refs, roles histogram, cut branches, and whether edit fields and list items show. */
export function treeStats(tree) {
  const roles = {};
  let nodes = 0;
  let refs = 0;
  let cut = 0;
  let composeLike = 0;
  let listItems = 0;
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    nodes++;
    const role = String(node.role ?? "unknown");
    roles[role] = (roles[role] ?? 0) + 1;
    if (node.ref_id) refs++;
    if (typeof node.children_count === "number" && !Array.isArray(node.children)) cut += node.children_count;
    if (EDIT_ROLES.has(role) && role !== "searchfield" && !SEARCH_NAME.test(String(node.name ?? ""))) composeLike++;
    if (LIST_ROLES.has(role)) listItems++;
    if (Array.isArray(node.children)) node.children.forEach(walk);
  };
  walk(tree);
  return { nodes, refs, roles, cut_children: cut, compose_like: composeLike, list_nodes: listItems };
}

/** The window to drive: not a meeting window if one exists, then the focused one, then the largest. */
export function pickWindow(windows) {
  const area = (w) => (w.bounds ? Number(w.bounds.width) * Number(w.bounds.height) : 0);
  const usable = windows.filter((w) => w && w.id && w.accessible !== false);
  const pool = usable.filter((w) => !titleClass(w.title).startsWith("meeting"));
  const list = pool.length > 0 ? pool : usable;
  return [...list].sort((a, b) => Number(Boolean(b.is_focused)) - Number(Boolean(a.is_focused)) || area(b) - area(a))[0] ?? null;
}

/** The process ids from pid up to the root, from rows of { ProcessId, ParentProcessId }. */
export function ancestry(rows, pid) {
  const parent = new Map(rows.map((row) => [Number(row.ProcessId), Number(row.ParentProcessId)]));
  const chain = [];
  for (let at = pid; at && !chain.includes(at) && chain.length < 64; at = parent.get(at)) chain.push(at);
  return chain;
}

/** Command-line options, or { error }. */
export function parseArgs(argv) {
  const options = { json: false, verbose: false, keep: false, skipLaunch: false, timeoutMs: 30000, app: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--skip-launch") options.skipLaunch = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--timeout-ms" || arg === "--app") {
      const value = argv[++i];
      if (value === undefined) return { error: `${arg} needs a value` };
      if (arg === "--app") options.app = value;
      else {
        const ms = Number(value);
        if (!Number.isInteger(ms) || ms < 1000) return { error: "--timeout-ms must be an integer of at least 1000" };
        options.timeoutMs = ms;
      }
    } else return { error: `unknown option ${arg}` };
  }
  return options;
}

// ---------- Running agent-desktop ----------

/** Short, name-free fields from an error envelope: code, kind, delivery and the failed actionability checks. */
function errorFields(error) {
  const details = error?.details ?? {};
  const checks = details.checks ?? details.last_report?.checks ?? [];
  return {
    code: String(error?.code ?? "ERROR"),
    kind: details.kind ? String(details.kind) : undefined,
    delivery: error?.disposition?.delivery,
    checks: Array.isArray(checks) ? checks.filter((check) => check?.status === "fail").map((check) => String(check.check)).join(",") || undefined : undefined,
  };
}

function spawnBinary(bin, args, { timeoutMs, stdin }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolve({ stdout: "", stderr: "", spawnError: String(error?.code ?? error) });
      return;
    }
    const out = [];
    const err = [];
    let size = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size <= 64 * 1024 * 1024) out.push(chunk);
    });
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ stdout: "", stderr: "", spawnError: String(error?.code ?? error) });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8").slice(0, 4000), exitCode, timedOut });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin ?? "");
  });
}

function createRunner(bin, options, ctx) {
  /** One agent-desktop call. Never throws. Returns { ok, data, code, kind, delivery, checks, message, cmd, ms }. */
  return async function ad(args, { stdin, timeoutMs = options.timeoutMs } = {}) {
    const cmd = args.join(" ");
    const refused = guardCommand(args, ctx);
    if (refused) return { ok: false, code: "GUARD_REFUSED", message: refused, cmd, ms: 0 };
    const start = Date.now();
    const run = await spawnBinary(bin, args, { timeoutMs, stdin });
    const ms = Date.now() - start;
    if (run.spawnError) return { ok: false, code: "SPAWN_FAILED", message: run.spawnError, cmd, ms };
    if (run.timedOut) return { ok: false, code: "SCRIPT_TIMEOUT", message: `killed after ${timeoutMs} ms`, cmd, ms };
    const envelope = parseEnvelope(run.stdout);
    if (!envelope) return { ok: false, code: "BAD_OUTPUT", message: `exit ${run.exitCode}; ${run.stderr.trim().slice(0, 200)}`, cmd, ms };
    if (envelope.ok) return { ok: true, data: envelope.data, delivery: envelope.data?.disposition?.delivery, cmd, ms };
    return { ok: false, ...errorFields(envelope.error), message: String(envelope.error?.message ?? ""), cmd, ms };
  };
}

/** "code=X kind=Y delivery=Z checks=a,b" for a failed result; verbose adds the message, which can hold names. */
function why(result, verbose) {
  if (result.ok) return result.delivery ? `delivery=${result.delivery}` : "ok";
  const parts = [`code=${result.code}`];
  if (result.kind) parts.push(`kind=${result.kind}`);
  if (result.delivery) parts.push(`delivery=${result.delivery}`);
  if (result.checks) parts.push(`checks=${result.checks}`);
  if (verbose && result.message) parts.push(`msg="${result.message}"`);
  if (result.code === "GUARD_REFUSED") parts.push(`(${result.message})`);
  return parts.join(" ");
}

const mechanisms = (data) => (Array.isArray(data?.steps) ? data.steps.map((s) => `${s.mechanism ?? "?"}:${s.outcome ?? "?"}`).join(",") : "");

// ---------- The check ----------

const HELP = `Usage: node scripts/teams-control-check.mjs [options]

Checks, step by step, whether agent-desktop can drive Microsoft Teams on this machine. Never sends a message.

  --json            print only the summary JSON
  --verbose         include window titles, element names and error messages
  --keep            keep the screenshot PNG
  --skip-launch     do not start Teams when it is not running
  --timeout-ms N    per-command timeout in ms (default 30000)
  --app NAME        use this process name for Teams instead of detecting it
Env: AGENT_DESKTOP_PATH overrides the agent-desktop binary.
Exit code: 0 when every critical step passes, 1 otherwise, 2 on bad options or a failed guard self-test.`;

// A group passes when any of its steps passes.
const CRITICAL = [
  ["version"], ["status"], ["permissions"], ["list-apps"], ["teams-process"], ["list-windows"], ["focus-window"], ["snapshot-skeleton"],
  ["find-chat-item"], ["click-semantic", "click-headed"], ["press-search"], ["find-compose"], ["set-value", "type-headed", "paste"],
  ["compose-clean"], ["screenshot"], ["mouse-move"],
];

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.error) {
    console.error(`${options.error}\n\n${HELP}`);
    return 2;
  }
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  const say = (line) => {
    if (!options.json) console.log(line);
  };

  const selfTest = guardSelfTest();
  if (selfTest.length > 0) {
    console.error(`Guard self-test failed, nothing was run:\n  ${selfTest.join("\n  ")}`);
    return 2;
  }

  const mac = process.platform === "darwin";
  const mod = mac ? "cmd" : "ctrl";
  const ctx = { composeFocused: false, refNames: new Map() };
  const steps = [];
  const facts = { teams_process: null, displays: [], agent_desktop: null };
  const S = { teams: null, window: null, windowArgs: [], chatRef: null, composeRef: null, composeTouched: false };
  const T = options.timeoutMs;
  const cliTimeout = String(Math.max(1000, T - 5000));

  /** Runs one step, prints its line, never throws. fn returns { status, reason, info?, code?, kind? }. */
  async function step(name, fn) {
    const start = Date.now();
    let result;
    try {
      result = await fn();
    } catch (error) {
      result = { status: "FAIL", code: "SCRIPT_ERROR", reason: `script error: ${error?.message ?? error}` };
    }
    const ms = Date.now() - start;
    const row = { step: name, status: result.status, ms, code: result.code, kind: result.kind, info: result.info, cmd: result.cmd };
    steps.push(row);
    say(`${result.status.padEnd(4)}  ${name.padEnd(20)} ${String(ms).padStart(6)}ms  ${result.reason ?? ""}`);
    return result;
  }
  const skip = (reason) => ({ status: "SKIP", reason });
  const fromResult = (result, okReason, extra = {}) =>
    result.ok
      ? { status: "PASS", reason: okReason, cmd: result.cmd, ...extra }
      : { status: "FAIL", reason: why(result, options.verbose), code: result.code, kind: result.kind, cmd: result.cmd, ...extra };

  const resolved = resolveBinary({ env: process.env, platform: process.platform, arch: process.arch, root: ROOT, exists: existsSync });
  say(`Teams control check: ${process.platform}-${process.arch}, node ${process.version}, timeout ${T} ms`);
  if (resolved.error) {
    await step("binary", () => ({ status: "FAIL", code: "NO_BINARY", reason: resolved.error }));
    return finish(steps, facts, options, say);
  }
  say(`agent-desktop: ${resolved.source === "node_modules" ? "bundled" : "AGENT_DESKTOP_PATH"} ${options.verbose ? resolved.path : ""}`.trimEnd());
  const ad = createRunner(resolved.path, options, ctx);
  const target = () => S.windowArgs;

  // Captured first so nothing this script does has moved focus yet (reported as step 11).
  const foregroundAtStart = process.platform === "win32" ? await readForeground(ad, T) : null;

  // 1. version, status, permissions, displays
  await step("version", async () => {
    const r = await ad(["version"]);
    if (r.ok) facts.agent_desktop = { version: r.data?.version, target: r.data?.target, os: r.data?.os, source: resolved.source };
    return fromResult(r, `${r.data?.version} ${r.data?.os} ${r.data?.target}`);
  });
  await step("status", async () => {
    const r = await ad(["status"]);
    if (!r.ok) return fromResult(r);
    const surfaces = r.data?.supported_surfaces ?? [];
    const ok = surfaces.length > 0;
    return { status: ok ? "PASS" : "FAIL", code: ok ? undefined : "NO_SURFACES", cmd: r.cmd, info: { surfaces }, reason: `surfaces=${surfaces.join(",") || "none (accessibility bus did not answer)"}` };
  });
  await step("permissions", async () => {
    const r = await ad(["permissions"]);
    if (!r.ok) return fromResult(r);
    const state = (key) => r.data?.[key]?.state ?? "unknown";
    const info = { accessibility: state("accessibility"), screen_recording: state("screen_recording"), automation: state("automation") };
    const ok = info.accessibility === "granted" || info.accessibility === "not_required";
    const hint = !ok && options.verbose ? ` hint="${r.data?.accessibility?.suggestion ?? ""}"` : "";
    return { status: ok ? "PASS" : "FAIL", code: ok ? undefined : "ACCESSIBILITY_DENIED", cmd: r.cmd, info, reason: `accessibility=${info.accessibility} screen_recording=${info.screen_recording} automation=${info.automation}${hint}` };
  });
  await step("list-displays", async () => {
    const r = await ad(["list-displays"]);
    if (!r.ok) return fromResult(r);
    const list = Array.isArray(r.data) ? r.data : (r.data?.displays ?? []);
    facts.displays = list.map((d) => ({ scale: d.scale, width: d.bounds?.width, height: d.bounds?.height, primary: Boolean(d.is_primary) }));
    return { status: "PASS", cmd: r.cmd, reason: facts.displays.map((d) => `${d.width}x${d.height}@${d.scale}${d.primary ? "*" : ""}`).join(" ") || "none" };
  });

  // 2. Teams process
  const findTeams = (apps) => {
    if (options.app) return apps.filter((app) => String(app.name).toLowerCase() === options.app.toLowerCase());
    return apps.filter(isTeamsApp).sort((a, b) => Number(b.presentation === "foreground") - Number(a.presentation === "foreground"));
  };
  const listApps = async () => {
    const r = await ad(["list-apps"]);
    const apps = r.ok ? (Array.isArray(r.data) ? r.data : (r.data?.apps ?? [])) : [];
    return { r, apps, teams: findTeams(apps) };
  };
  let apps = { r: { ok: false, code: "NOT_RUN" }, apps: [], teams: [] };
  await step("list-apps", async () => {
    apps = await listApps();
    return fromResult(apps.r,`apps=${apps.apps.length} teams=${apps.teams.length}${apps.teams[0] ? ` name=${apps.teams[0].name}` : ""}`, { info: { apps: apps.apps.length, teams: apps.teams.length } });
  });
  await step("launch", async () => {
    if (apps.teams.length > 0) return skip("Teams already running");
    if (!apps.r.ok) return skip("list-apps failed");
    if (options.skipLaunch) return skip("Teams not running; --skip-launch");
    const name = options.app ?? (process.platform === "win32" ? "ms-teams.exe" : mac ? "Microsoft Teams" : "teams-for-linux");
    say(`      launching ${name} with --activate (Teams was not running)`);
    const r = await ad(["launch", name, "--activate", "--timeout", cliTimeout]);
    if (r.ok) {
      apps = await listApps();
      return fromResult(r, `launched ${name} via agent-desktop; teams=${apps.teams.length}`);
    }
    if (process.platform !== "win32") return fromResult(r);
    // agent-desktop launch takes a System32 name or a path, and new Teams is a Store app, so Windows falls back to the URI Bee uses.
    say(`      agent-desktop launch failed (${why(r, false)}); opening msteams: instead`);
    await spawnBinary("explorer.exe", ["msteams:"], { timeoutMs: 10000 });
    const deadline = Date.now() + T;
    do {
      await new Promise((done) => setTimeout(done, 1500));
      apps = await listApps();
    } while (apps.teams.length === 0 && Date.now() < deadline);
    return apps.teams.length > 0
      ? { status: "PASS", cmd: "explorer.exe msteams:", reason: `agent-desktop launch failed (${r.code}); msteams: URI started Teams` }
      : { status: "FAIL", code: r.code, kind: r.kind, cmd: r.cmd, reason: `${why(r, options.verbose)}; msteams: URI did not start Teams in time` };
  });
  await step("teams-process", async () => {
    S.teams = apps.teams[0] ?? null;
    if (!S.teams && !apps.r.ok) return { status: "FAIL", code: apps.r.code, kind: apps.r.kind, reason: `unknown: list-apps failed (${apps.r.code})` };
    if (!S.teams) return { status: "FAIL", code: "TEAMS_NOT_RUNNING", reason: options.app ? `no running app named ${options.app}` : "no Teams process in list-apps (ms-teams.exe, Teams.exe, Microsoft Teams)" };
    facts.teams_process = String(S.teams.name);
    return { status: "PASS", reason: `name=${S.teams.name} pid=${S.teams.pid ?? "?"} presentation=${S.teams.presentation ?? "-"} instances=${apps.teams.length}` };
  });

  // 3. Windows
  await step("list-windows", async () => {
    if (!S.teams) return skip("Teams not running");
    let r = await ad(["list-windows", "--app", String(S.teams.name)]);
    let rows = r.ok ? (Array.isArray(r.data) ? r.data : (r.data?.windows ?? [])) : [];
    let note = "";
    if (rows.length === 0) {
      const all = await ad(["list-windows"]);
      const pids = new Set(apps.teams.map((app) => app.pid));
      rows = all.ok ? (Array.isArray(all.data) ? all.data : (all.data?.windows ?? [])).filter((w) => pids.has(w.pid) || isTeamsApp({ name: w.app_name })) : [];
      note = ` (--app gave ${r.ok ? "none" : r.code}; matched by pid)`;
      if (!r.ok && rows.length === 0) return fromResult(r);
    }
    S.window = pickWindow(rows);
    if (!S.window) return { status: "FAIL", code: "NO_WINDOW", cmd: r.cmd, reason: `windows=${rows.length}, none accessible${note}` };
    S.windowArgs = ["--app", String(S.teams.name), "--window-id", String(S.window.id)];
    const b = S.window.bounds;
    const bounds = b ? `${Math.round(b.width)}x${Math.round(b.height)}@${Math.round(b.x)},${Math.round(b.y)}` : "none";
    const title = options.verbose ? ` title="${S.window.title}"` : "";
    return {
      status: "PASS",
      cmd: r.cmd,
      info: { windows: rows.length, class: titleClass(S.window.title), bounds: Boolean(b) },
      reason: `windows=${rows.length} id=${S.window.id} class=${titleClass(S.window.title)} bounds=${bounds} focused=${Boolean(S.window.is_focused)}${title}${note}`,
    };
  });

  // 4. Focus
  await step("focus-window", async () => {
    if (!S.window) return skip("no Teams window");
    const r = await ad(["focus-window", "--window-id", String(S.window.id)]);
    const after = await ad(["list-windows"]);
    const rows = after.ok ? (Array.isArray(after.data) ? after.data : (after.data?.windows ?? [])) : [];
    const focused = rows.find((w) => w.is_focused);
    const onTeams = focused ? String(focused.id) === String(S.window.id) : false;
    const tail = `os_focus_on_teams=${onTeams}${focused && !onTeams ? ` focused_app=${focused.app_name}` : ""}`;
    if (!r.ok) return { ...fromResult(r), reason: `${why(r, options.verbose)} ${tail}` };
    return { status: onTeams ? "PASS" : "FAIL", code: onTeams ? undefined : "FOCUS_NOT_MOVED", cmd: r.cmd, reason: `${why(r, false)} ${tail}` };
  });

  // 5. Snapshot
  const snapshotStep = async (name, extra) =>
    step(name, async () => {
      if (!S.window) return skip("no Teams window");
      const r = await ad(["snapshot", ...target(), ...extra, "--timeout-ms", cliTimeout]);
      if (!r.ok) return fromResult(r);
      const stats = treeStats(r.data?.tree);
      const top = Object.entries(stats.roles).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([role, n]) => `${role}:${n}`).join(",");
      const flags = `complete=${r.data?.complete !== false}${r.data?.identity_unproven ? " identity_unproven" : ""}`;
      return {
        status: "PASS",
        cmd: r.cmd,
        info: { ...stats, complete: r.data?.complete !== false, identity_unproven: Boolean(r.data?.identity_unproven) },
        reason: `nodes=${stats.nodes} refs=${stats.refs} edit_like=${stats.compose_like} list_nodes=${stats.list_nodes} cut_children=${stats.cut_children} ${flags} roles=${top}`,
      };
    });
  await snapshotStep("snapshot-skeleton", ["--skeleton", "-i", "--compact"]);
  // Not in the brief's list, but a skeleton stops at depth 3, so Teams' compose box and chat list rarely show in it.
  await snapshotStep("snapshot-deep", ["-i", "--compact", "--max-depth", "60"]);

  // 6. Chat list item: semantic click, then headed click
  const findChatItem = async () => {
    for (const role of ["treeitem", "listitem"]) {
      const r = await ad(["find", ...target(), "--role", role, "--limit", "40", "--timeout-ms", cliTimeout]);
      if (!r.ok) return { r };
      const matches = (r.data?.matches ?? []).filter((m) => m.ref_id);
      for (const m of matches) ctx.refNames.set(m.ref_id, String(m.name ?? ""));
      const states = (m) => (Array.isArray(m.states) ? m.states.map(String) : []);
      const leaf = matches.find((m) => !states(m).some((s) => s === "expanded" || s === "collapsed" || s === "expandable")) ?? matches[0];
      if (leaf) return { r, role, ref: leaf.ref_id, count: matches.length, name: String(leaf.name ?? "") };
      if (role === "listitem") return { r, rolesPresent: r.data?.roles_present };
    }
    return {};
  };
  await step("find-chat-item", async () => {
    if (!S.window) return skip("no Teams window");
    const found = await findChatItem();
    if (!found.r?.ok) return fromResult(found.r);
    if (!found.ref) return { status: "FAIL", code: "NO_CHAT_ITEM", cmd: found.r.cmd, reason: `no treeitem/listitem with a ref; roles_present=${(found.rolesPresent ?? []).join(",") || "?"}` };
    S.chatRef = found.ref;
    return { status: "PASS", cmd: found.r.cmd, info: { role: found.role, count: found.count }, reason: `role=${found.role} items=${found.count} ref=${found.ref}${options.verbose ? ` name="${found.name}"` : ""}` };
  });
  await step("click-semantic", async () => {
    if (!S.chatRef) return skip("no chat item");
    const r = await ad(["click", S.chatRef]);
    return fromResult(r, `delivery=${r.delivery} steps=${mechanisms(r.data)}`);
  });
  await step("click-headed", async () => {
    if (!S.chatRef) return skip("no chat item");
    const fresh = await findChatItem(); // the semantic click may have changed the list, so take a fresh ref
    if (fresh.ref) S.chatRef = fresh.ref;
    const r = await ad(["--headed", "click", S.chatRef]);
    return fromResult(r, `delivery=${r.delivery} steps=${mechanisms(r.data)}`);
  });

  // 7. Search shortcut
  await step("press-search", async () => {
    if (!S.window) return skip("no Teams window");
    const r = await ad(["--headed", "press", `${mod}+e`, ...target()]);
    if (!r.ok) return fromResult(r);
    await new Promise((done) => setTimeout(done, 600));
    const f = await ad(["find", ...target(), "--state", "focused", "--limit", "5", "--timeout-ms", cliTimeout]);
    const focusedMatches = f.ok ? (f.data?.matches ?? []) : [];
    const match = focusedMatches.find((m) => EDIT_ROLES.has(String(m.role))) ?? focusedMatches.find((m) => m.ref_id) ?? focusedMatches[0] ?? null;
    const role = match ? String(match.role ?? "?") : "none";
    const searchLike = Boolean(match) && (role === "searchfield" || role === "combobox" || (EDIT_ROLES.has(role) && SEARCH_NAME.test(String(match.name ?? ""))));
    await ad(["--headed", "press", "escape", ...target()]); // leave search so the compose steps start from the chat
    const tail = `focused_role=${role} search_like=${searchLike}${f.ok ? "" : ` find=${f.code}`}${options.verbose && match ? ` name="${match.name ?? ""}"` : ""}`;
    return { status: searchLike ? "PASS" : "FAIL", code: searchLike ? undefined : "FOCUS_NOT_IN_SEARCH", cmd: r.cmd, info: { focused_role: role, search_like: searchLike }, reason: `delivery=${r.delivery} ${tail}` };
  });

  // 8. Compose box
  /** The compose value: value first; text falls back to the name when empty, so text equal to the name reads as "". Null when unreadable. */
  const readCompose = async () => {
    const v = await ad(["get", S.composeRef, "--property", "value"]);
    if (v.ok && typeof v.data?.value === "string") return v.data.value;
    const t = await ad(["get", S.composeRef, "--property", "text"]);
    if (t.ok && typeof t.data?.value === "string") return t.data.value === ctx.refNames.get(S.composeRef) ? "" : t.data.value;
    if (t.ok && typeof t.data?.text === "string") return t.data.text === ctx.refNames.get(S.composeRef) ? "" : t.data.text;
    return null;
  };
  const readback = (value) => (value === null ? "unreadable" : value.includes(MARKER) ? "marker" : value === "" ? "empty" : "other");
  const composeFocused = async () => {
    const r = await ad(["is", S.composeRef, "--property", "focused"]);
    return r.ok && r.data?.result === true;
  };
  /** Removes the marker: clear, then (if it stayed and the box has focus) select-all and delete. */
  const cleanCompose = async () => {
    const r = await ad(["clear", S.composeRef]);
    let value = await readCompose();
    if (value !== null && value.includes(MARKER)) {
      await ad(["--headed", "focus", S.composeRef]);
      if (await composeFocused()) {
        ctx.composeFocused = true;
        await ad(["--headed", "press", `${mod}+a`, ...target()]);
        await ad(["--headed", "press", "delete", ...target()]);
        value = await readCompose();
      }
    }
    return { r, value };
  };
  let composeEmptyAtStart = false;
  await step("find-compose", async () => {
    if (!S.window) return skip("no Teams window");
    const r = await ad(["find", ...target(), "--role", "textfield", "--limit", "40", "--timeout-ms", cliTimeout]);
    if (!r.ok) return fromResult(r);
    const all = (r.data?.matches ?? []).filter((m) => m.ref_id);
    for (const m of all) ctx.refNames.set(m.ref_id, String(m.name ?? ""));
    const candidates = all.filter((m) => !SEARCH_NAME.test(String(m.name ?? "")) && !SEND_NAME.test(String(m.name ?? "")));
    if (candidates.length === 0) return { status: "FAIL", code: "NO_COMPOSE", cmd: r.cmd, reason: `textfields=${all.length}, none that is not search; roles_present=${(r.data?.roles_present ?? []).join(",") || "-"}` };
    let pick = candidates.find((m) => /type a message|message|reply|nachricht|mensaje|messaggio|bericht|mensagem|wiadomo/i.test(String(m.name ?? "")));
    let by = "name";
    if (!pick) {
      by = "lowest";
      let best = -Infinity;
      for (const m of candidates.slice(0, 8)) {
        const b = await ad(["get", m.ref_id, "--property", "bounds"]);
        const y = Number(b.data?.value?.y ?? b.data?.bounds?.y ?? b.data?.y);
        if (b.ok && Number.isFinite(y) && y > best) [best, pick] = [y, m];
      }
      pick ??= candidates.at(-1);
    }
    S.composeRef = pick.ref_id;
    const value = await readCompose();
    composeEmptyAtStart = value === "";
    const state = value === null ? "unreadable" : value === "" ? "empty" : "has-draft";
    const ok = composeEmptyAtStart;
    return {
      status: ok ? "PASS" : "FAIL",
      code: ok ? undefined : value === null ? "READBACK_UNAVAILABLE" : "COMPOSE_HAS_DRAFT",
      cmd: r.cmd,
      info: { textfields: all.length, candidates: candidates.length, picked_by: by, start: state },
      reason: `textfields=${all.length} candidates=${candidates.length} picked_by=${by} ref=${pick.ref_id} start=${state}${ok ? "" : " (compose steps will not write to it)"}${options.verbose ? ` name="${pick.name ?? ""}"` : ""}`,
    };
  });
  const canWrite = () => (S.composeRef && composeEmptyAtStart ? null : skip(S.composeRef ? "compose box not proven empty; not touched" : "no compose box"));
  const writeStep = (name, write) =>
    step(name, async () => {
      const blocked = canWrite();
      if (blocked) return blocked;
      S.composeTouched = true;
      const r = await write();
      if (r.skip) return skip(r.skip);
      const value = await readCompose();
      const clean = await cleanCompose();
      const back = readback(value);
      const cleaned = readback(clean.value);
      const ok = r.ok && back === "marker";
      const head = r.ok ? `delivery=${r.delivery} steps=${mechanisms(r.data)}` : why(r, options.verbose);
      return {
        status: ok ? "PASS" : "FAIL",
        code: ok ? undefined : r.ok ? `READBACK_${back.toUpperCase()}` : r.code,
        kind: r.kind,
        cmd: r.cmd,
        info: { readback: back, after_clear: cleaned },
        reason: `${head} readback=${back} after_clear=${cleaned}${r.note ?? ""}`,
      };
    });
  await writeStep("set-value", () => ad(["set-value", S.composeRef, MARKER]));
  await writeStep("type-headed", async () => {
    ctx.composeFocused = true; // a headed type focuses the field
    return ad(["--headed", "type", S.composeRef, MARKER]);
  });
  await writeStep("paste", async () => {
    const saved = await ad(["clipboard-get", "--format", "auto"]);
    if (!saved.ok) return saved;
    const type = saved.data?.found === false ? "empty" : String(saved.data?.type ?? "?");
    if (type !== "empty" && type !== "text") return { skip: `clipboard holds ${type}; not touched` };
    const restore = async () => {
      if (type === "empty") await ad(["clipboard-clear"]);
      else await ad(["clipboard-set", "--stdin"], { stdin: String(saved.data?.text ?? "") });
      const now = await ad(["clipboard-get", "--format", "auto"]);
      const same = type === "empty" ? now.data?.found === false : now.data?.text === saved.data?.text;
      return now.ok && same;
    };
    const set = await ad(["clipboard-set", MARKER]);
    if (!set.ok) return { ...set, note: ` clipboard_restored=${await restore()}` };
    await ad(["--headed", "focus", S.composeRef]);
    if (!(await composeFocused())) {
      const restored = await restore();
      return { ok: false, code: "COMPOSE_NOT_FOCUSED", cmd: "focus + is focused", note: ` (paste not sent) clipboard_restored=${restored}` };
    }
    ctx.composeFocused = true;
    const r = await ad(["--headed", "press", `${mod}+v`, ...target()]);
    await new Promise((done) => setTimeout(done, 400));
    const restored = await restore();
    return { ...r, note: ` clipboard_was=${type} clipboard_restored=${restored}` };
  });
  await step("compose-clean", async () => {
    if (!S.composeTouched) return skip("compose box was not written");
    const value = await readCompose();
    const state = readback(value);
    if (state === "marker") return { status: "FAIL", code: "MARKER_LEFT", reason: `"${MARKER}" may still be in the compose box: delete it by hand (it was not sent)` };
    return { status: state === "unreadable" ? "FAIL" : "PASS", code: state === "unreadable" ? "READBACK_UNAVAILABLE" : undefined, reason: `compose=${state}` };
  });
  ctx.composeFocused = false;

  // 9. Screenshot
  await step("screenshot", async () => {
    if (!S.window) return skip("no Teams window");
    const dir = mkdtempSync(join(os.tmpdir(), "teams-check-"));
    const file = join(dir, "teams.png");
    try {
      const r = await ad(["screenshot", ...target(), file]);
      if (!r.ok) return fromResult(r);
      if (!existsSync(file)) return { status: "FAIL", code: "NO_FILE", cmd: r.cmd, reason: "command ok but no PNG written" };
      const size = pngSize(readFileSync(file));
      const bytes = statSync(file).size;
      const ok = Boolean(size) && size.width > 0 && size.height > 0;
      return {
        status: ok ? "PASS" : "FAIL",
        code: ok ? undefined : "BAD_PNG",
        cmd: r.cmd,
        info: { bytes, width: size?.width, height: size?.height },
        reason: `bytes=${bytes} size=${size ? `${size.width}x${size.height}` : "not a PNG"}${options.keep ? ` kept=${file}` : ""}`,
      };
    } finally {
      if (!options.keep) rmSync(dir, { recursive: true, force: true });
    }
  });

  // 10. Pointer
  await step("mouse-move", async () => {
    const b = S.window?.bounds;
    if (!b) return skip(S.window ? "window has no bounds" : "no Teams window");
    const x = Math.round(Number(b.x) + Number(b.width) / 2);
    const y = Math.round(Number(b.y) + Number(b.height) / 2);
    const r = await ad(["--headed", "mouse-move", `--xy=${x},${y}`]);
    return fromResult(r, `xy=${x},${y} delivery=${r.delivery}`);
  });

  // 11. Foreground at start (Windows)
  await step("console-foreground", async () => {
    if (process.platform !== "win32") return skip("Windows only");
    const f = foregroundAtStart;
    if (!f?.ok) return { status: "FAIL", code: f?.code ?? "UNKNOWN", reason: `could not read the foreground window at start (${f?.code ?? "?"})` };
    const yes = f.inAncestry || f.terminalLike;
    return {
      status: yes ? "PASS" : "FAIL",
      code: yes ? undefined : "CONSOLE_NOT_FOREGROUND",
      info: { focused_app: f.app, in_ancestry: f.inAncestry, terminal_like: f.terminalLike },
      reason: `at start focused_app=${f.app ?? "none"} in_ancestry=${f.inAncestry} terminal_like=${f.terminalLike}${yes ? "" : "; Windows may deny SetForegroundWindow to this script"}`,
    };
  });

  return finish(steps, facts, options, say);
}

const TERMINALS = new Set(["windowsterminal", "openconsole", "conhost", "cmd", "powershell", "pwsh", "code", "wezterm-gui", "alacritty", "mintty", "conemu", "conemu64", "tabby", "hyper", "warp", "node"]);

/** The foreground window at start, and whether it belongs to this script's console (an ancestor process or a terminal). */
async function readForeground(ad, timeoutMs) {
  const r = await ad(["list-windows"]);
  if (!r.ok) return { ok: false, code: r.code };
  const rows = Array.isArray(r.data) ? r.data : (r.data?.windows ?? []);
  const focused = rows.find((w) => w.is_focused);
  if (!focused) return { ok: true, app: null, inAncestry: false, terminalLike: false };
  const ps = await spawnBinary(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress"],
    { timeoutMs: Math.min(timeoutMs, 20000) },
  );
  let chain = [];
  try {
    chain = ancestry(JSON.parse(ps.stdout || "[]"), process.pid);
  } catch {
    chain = [process.pid];
  }
  const app = String(focused.app_name ?? "").replace(/\.exe$/i, "");
  return { ok: true, app, inAncestry: chain.includes(Number(focused.pid)), terminalLike: TERMINALS.has(app.toLowerCase()) };
}

function finish(steps, facts, options, say) {
  const passed = (name) => steps.some((s) => s.step === name && s.status === "PASS");
  const failedGroups = CRITICAL.filter((group) => !group.some(passed)).map((group) => group.join("|"));
  const criticalOk = failedGroups.length === 0;
  const summary = {
    tool: "teams-control-check",
    when: new Date().toISOString(),
    os: { platform: process.platform, arch: process.arch, release: os.release(), version: typeof os.version === "function" ? os.version() : undefined },
    node: process.version,
    agent_desktop: facts.agent_desktop,
    displays: facts.displays,
    teams_process: facts.teams_process,
    critical_ok: criticalOk,
    first_failure: steps.find((s) => s.status === "FAIL" && (s.step === "binary" || CRITICAL.some((group) => group.includes(s.step))))?.step ?? null,
    failed_critical: failedGroups,
    steps: steps.map((s) => ({ step: s.step, ok: s.status === "PASS", status: s.status, code: s.code, kind: s.kind, ms: s.ms, info: s.info, cmd: s.cmd })),
  };
  say("");
  say("Summary");
  say(`  ${"step".padEnd(20)} ${"result".padEnd(6)} ${"ms".padStart(6)}  code`);
  for (const s of steps) say(`  ${s.step.padEnd(20)} ${s.status.padEnd(6)} ${String(s.ms).padStart(6)}  ${s.code ?? ""}${s.kind ? `/${s.kind}` : ""}`);
  say(criticalOk ? "All critical steps passed." : `First critical failure: ${summary.first_failure ?? "-"}. Not passed: ${failedGroups.join(", ")}`);
  say("");
  say("Paste this JSON back to the developer:");
  console.log(JSON.stringify(summary));
  return criticalOk ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`teams-control-check crashed: ${error?.stack ?? error}`);
      process.exitCode = 1;
    },
  );
}
