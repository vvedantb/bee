import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertComputerUse,
  assertDesktopAction,
  assertReadOnly,
  parseEnvelope,
  type AgentDesktopResult,
  type ComputerRun,
  type ComputerUseCommand,
  type DesktopActionCommand,
  type ReadOnlyCommand,
} from "../core/agent-desktop-envelope";

// Runs the agent-desktop CLI (npm agent-desktop, Apache-2.0). The experimental meeting window reader gets a runner for
// read-only commands only (assertReadOnly). Bee's desktop tools for a direct request ("Bee, open Teams") get a separate runner
// for launching, focusing and listing apps only (assertDesktopAction). Computer use ("Bee, send Sam a message in Slack") gets a
// third, for observing and acting on one element at a time (assertComputerUse). The first two are always headless; computer use
// is headless unless the AI asks for physical keys on press, type or focus. One command at a time per runner, each with a
// timeout. stdout is parsed and dropped: nothing it holds is logged. Spawn failures come back as codes, never as throws.

export type AgentDesktopBinary = { path: string; macHelper: string | null };

/** The platform file names inside node_modules/agent-desktop/bin. Null where Bee ships no binary. */
export function platformBinaryNames(platform: NodeJS.Platform, arch: string): { binary: string; macHelper: string | null } | null {
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) return { binary: `agent-desktop-darwin-${arch}`, macHelper: `agent-desktop-macos-helper-darwin-${arch}` };
  if (platform === "win32" && (arch === "x64" || arch === "arm64")) return { binary: `agent-desktop-win32-${arch}.exe`, macHelper: null };
  if (platform === "linux" && (arch === "x64" || arch === "arm64")) return { binary: `agent-desktop-linux-${arch}`, macHelper: null };
  return null;
}

/**
 * Where the binary is. Packaged: Resources/agent-desktop/agent-desktop[.exe] (and agent-desktop-macos-helper beside it), copied
 * there per platform by build.mac / build.win extraResources in package.json. Development: node_modules/agent-desktop/bin.
 */
export function resolveAgentDesktop(args: {
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
  platform?: NodeJS.Platform;
  arch?: string;
  exists?: (path: string) => boolean;
}): AgentDesktopBinary | null {
  const platform = args.platform ?? process.platform;
  const exists = args.exists ?? existsSync;
  const names = platformBinaryNames(platform, args.arch ?? process.arch);
  if (!names) return null;
  if (args.packaged) {
    const dir = join(args.resourcesPath, "agent-desktop");
    const path = join(dir, platform === "win32" ? "agent-desktop.exe" : "agent-desktop");
    const helper = names.macHelper ? join(dir, "agent-desktop-macos-helper") : null;
    return exists(path) ? { path, macHelper: helper && exists(helper) ? helper : null } : null;
  }
  const dir = join(args.appPath, "node_modules", "agent-desktop", "bin");
  const path = join(dir, names.binary);
  const helper = names.macHelper ? join(dir, names.macHelper) : null;
  return exists(path) ? { path, macHelper: helper && exists(helper) ? helper : null } : null;
}

export type AgentDesktopRun = (command: ReadOnlyCommand, args: string[], options?: { timeoutMs?: number }) => Promise<AgentDesktopResult>;

export type ExecFile = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; windowsHide: boolean; env: NodeJS.ProcessEnv; encoding: "utf8"; signal?: AbortSignal },
  callback: (error: (Error & { code?: unknown; killed?: boolean }) | null, stdout: string) => void,
) => void;

const DEFAULT_TIMEOUT_MS = 6000;
// A dense call window snapshot can run to a few MB of JSON.
const MAX_BUFFER = 16 * 1024 * 1024;
// Names that look like secrets never reach the child (Bee's own Gateway key may be in the environment). Whole words only, so
// XAUTHORITY or KEYBOARD settings stay.
const SECRET_ENV = /(^|_)(API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)(_|$)/i;

/** Bee's environment without secret-looking variables, for any helper process Bee starts. */
export function withoutSecrets(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined || SECRET_ENV.test(name)) continue;
    env[name] = value;
  }
  return env;
}

/** Bee's environment without secrets or another agent-desktop session, plus Bee's private state folder and the macOS helper. */
export function childEnv(base: NodeJS.ProcessEnv, home: string, macHelper: string | null): NodeJS.ProcessEnv {
  const env = withoutSecrets(base);
  for (const name of Object.keys(env)) if (name.startsWith("AGENT_DESKTOP_")) delete env[name];
  env.AGENT_DESKTOP_HOME = home;
  if (macHelper) env.AGENT_DESKTOP_MACOS_HELPER_PATH = macHelper;
  return env;
}

export type AgentDesktopRunner = {
  run: AgentDesktopRun;
  /** Deletes the private state folder (agent-desktop keeps snapshot ref maps there). Safe to call often. */
  cleanup: () => void;
};

/** A synchronous execFile with an args array (no shell). Returns stdout; throws on a non-zero exit. */
export type ExecFileSync = (file: string, args: string[], options: { timeout: number; windowsHide: boolean; encoding: "utf8" }) => string;

type RunnerDeps = {
  exec?: ExecFile;
  env?: NodeJS.ProcessEnv;
  tempDir?: () => string;
  platform?: NodeJS.Platform;
  execSync?: ExecFileSync;
  warn?: (message: string) => void;
};

/** The SID from `whoami /user /fo csv /nh` ("DOMAIN\user","S-1-5-21-…"): the last quoted field. Null if there is none. */
export function parseWhoamiSid(output: string): string | null {
  const line = output.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  const fields = line.split(",").map((f) => f.trim().replace(/^"|"$/g, ""));
  const sid = fields[fields.length - 1] ?? "";
  return /^S-1-\d+(-\d+)+$/.test(sid) ? sid : null;
}

/**
 * Windows ignores mkdtemp's mode 0700, so a new folder inherits %TEMP%'s ACL, which can hold extra principals
 * (sandbox groups, unresolved SIDs). agent-desktop refuses a state folder that grants anyone but the current user, SYSTEM
 * and Administrators. This drops inheritance and grants only those three, by SID so it works in any Windows language.
 * Returns false (and warns with the tool output) on failure; the caller carries on.
 */
export function lockDownWindowsPrivateDir(
  dir: string,
  deps: { execSync?: ExecFileSync; warn?: (message: string) => void; env?: NodeJS.ProcessEnv } = {},
): boolean {
  const execSync = deps.execSync ?? (execFileSync as unknown as ExecFileSync);
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const system32 = join((deps.env ?? process.env).SystemRoot ?? "C:\\Windows", "System32");
  const options = { timeout: 10_000, windowsHide: true, encoding: "utf8" as const };
  let step = "whoami";
  try {
    const whoami = execSync(join(system32, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], options);
    const sid = parseWhoamiSid(whoami);
    if (!sid) {
      warn("Bee: could not lock down agent-desktop folder: no SID in whoami output");
      return false;
    }
    step = "icacls";
    execSync(join(system32, "icacls.exe"), [dir, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"], options);
    return true;
  } catch (error) {
    const e = error as { message?: string; stdout?: unknown; stderr?: unknown };
    const out = [e.stdout, e.stderr].map((v) => (v == null ? "" : String(v).trim())).filter(Boolean).join(" | ");
    warn(`Bee: could not lock down agent-desktop folder (${step} failed): ${e.message ?? String(error)}${out ? ` — ${out}` : ""}`);
    return false;
  }
}

/**
 * One command at a time. agent-desktop keeps snapshot ref maps under AGENT_DESKTOP_HOME; Bee points it at a private
 * temporary folder instead of ~/.agent-desktop, and deletes it when reading stops and at quit. Private means mode 0700 on
 * macOS and Linux (mkdtemp), and on Windows an ACL for the current user, SYSTEM and Administrators only
 * (lockDownWindowsPrivateDir).
 */
export function createAgentDesktopRunner(binary: AgentDesktopBinary, deps: RunnerDeps = {}): AgentDesktopRunner {
  return queuedRunner<ReadOnlyCommand>(binary, deps, assertReadOnly);
}

/** A desktop action command for Bee's desktop tools only: launch, focus-window, list-apps or list-windows (assertDesktopAction). */
export type AgentDesktopActionRun = (command: DesktopActionCommand, args: string[], options?: { timeoutMs?: number }) => Promise<AgentDesktopResult>;

export type AgentDesktopActionRunner = { run: AgentDesktopActionRun; cleanup: () => void };

/** The desktop tools' own runner, with its own state folder and queue. Never handed to the meeting window reader. */
export function createAgentDesktopActionRunner(binary: AgentDesktopBinary, deps: RunnerDeps = {}): AgentDesktopActionRunner {
  return queuedRunner<DesktopActionCommand>(binary, deps, assertDesktopAction);
}

/** Computer use's own runner, with its own state folder and queue (snapshot refs live there for one run). Never the reader's. */
export type AgentDesktopComputerRunner = { run: ComputerRun; cleanup: () => void };

export function createAgentDesktopComputerRunner(binary: AgentDesktopBinary, deps: RunnerDeps = {}): AgentDesktopComputerRunner {
  return queuedRunner<ComputerUseCommand>(binary, deps, assertComputerUse);
}

/** Runs one command at a time after `allow` checks it (it throws, before any process starts, for anything else). */
function queuedRunner<C extends string>(binary: AgentDesktopBinary, deps: RunnerDeps, allow: (command: string, args: readonly string[]) => void) {
  const exec: ExecFile = deps.exec ?? (execFile as unknown as ExecFile);
  let home: string | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const ensureHome = (): string => {
    if (home) return home;
    const dir = mkdtempSync(join(deps.tempDir?.() ?? tmpdir(), "bee-agent-desktop-"));
    if ((deps.platform ?? process.platform) === "win32") lockDownWindowsPrivateDir(dir, { execSync: deps.execSync, warn: deps.warn, env: deps.env });
    home = dir;
    return home;
  };

  const spawn = (command: C, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<AgentDesktopResult> =>
    new Promise((resolve) => {
      // Stopped while it waited its turn: it never starts.
      if (signal?.aborted) {
        resolve({ ok: false, code: "ABORTED" });
        return;
      }
      let dir: string;
      try {
        dir = ensureHome();
      } catch {
        resolve({ ok: false, code: "SPAWN_FAILED" });
        return;
      }
      try {
        const options = { timeout: timeoutMs, maxBuffer: MAX_BUFFER, windowsHide: true, env: childEnv(deps.env ?? process.env, dir, binary.macHelper), encoding: "utf8" as const };
        // The signal kills the command in flight (Stop, a newer request).
        exec(binary.path, [command, ...args], signal ? { ...options, signal } : options, (error, stdout) => {
          if (signal?.aborted) return resolve({ ok: false, code: "ABORTED" });
          // Exit code 1 still prints the error envelope, so stdout is read first.
          const parsed = parseEnvelope(stdout ?? "");
          if (parsed.ok || parsed.code !== "BAD_OUTPUT" || !error) return resolve(parsed);
          if (error.killed) return resolve({ ok: false, code: "TIMEOUT_LOCAL" });
          resolve({ ok: false, code: typeof error.code === "string" ? "SPAWN_FAILED" : "BAD_OUTPUT" });
        });
      } catch {
        resolve({ ok: false, code: "SPAWN_FAILED" });
      }
    });

  return {
    run: (command: C, args: string[], options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<AgentDesktopResult> => {
      // Throws on anything outside the runner's set, before a process starts.
      allow(command, args);
      const result = queue.then(() => spawn(command, args, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.signal));
      queue = result.catch(() => undefined);
      return result;
    },
    cleanup: () => {
      if (!home) return;
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        // A command still holding a file; the next cleanup or the OS temp sweep removes it.
      }
      home = null;
    },
  };
}
