import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import {
  assertComputerUse,
  assertDesktopAction,
  assertReadOnly,
  parseEnvelope,
  STDIN_FLAG,
  type AgentDesktopResult,
  type ComputerRun,
  type ComputerRunOptions,
  type ComputerUseCommand,
  type DesktopActionCommand,
  type ReadOnlyCommand,
} from "../core/agent-desktop-envelope";
import type { ComputerPlatform } from "../core/computer-control";

// Runs the agent-desktop CLI (npm agent-desktop, Apache-2.0). The experimental meeting window reader gets a runner for
// read-only commands only (assertReadOnly). Bee's desktop tools for a direct request ("Bee, open Teams") get a separate runner
// for launching, focusing and listing apps only (assertDesktopAction). Computer use ("Bee, send Sam a message in Slack") gets a
// third, for observing and acting on one element at a time (assertComputerUse). The first two are always headless; computer use
// is headless unless the AI asks for physical keys on press, type or focus. One command at a time per runner, each with a
// timeout. stdout is parsed and dropped: nothing it holds is logged. Spawn failures come back as codes, never as throws. Text
// that computer use types or sets goes on the child's stdin (--stdin), never in argv, and is never logged.

export type AgentDesktopBinary = { path: string; macHelper: string | null };

/** Where computer use runs, from Node's platform name, or null where it does not (no agent-desktop binary ships). */
export function computerPlatformOf(platform: NodeJS.Platform): ComputerPlatform | null {
  return platform === "darwin" ? "mac" : platform === "win32" ? "windows" : platform === "linux" ? "linux" : null;
}

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
  options: { timeout: number; maxBuffer: number; windowsHide: boolean; env: NodeJS.ProcessEnv; encoding: "utf8"; signal?: AbortSignal; stdin?: string },
  callback: (error: (Error & { code?: unknown; killed?: boolean }) | null, stdout: string) => void,
) => void;

/**
 * execFile, plus `stdin` written to the child as UTF-8 and then closed. execFile already pipes stdin, so its timeout, kill,
 * signal and buffer limit stay as they are. A child that exits before reading gives EPIPE on the pipe: ignored, as the
 * callback reports the exit.
 */
const execWithStdin: ExecFile = (file, args, { stdin, ...options }, callback) => {
  const child = execFile(file, args, options, callback);
  if (stdin === undefined || !child.stdin) return;
  child.stdin.on("error", () => undefined);
  child.stdin.end(stdin, "utf8");
};

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

type RunnerDeps = { exec?: ExecFile; env?: NodeJS.ProcessEnv; tempDir?: () => string; lockAcl?: (dir: string) => void };

export type ExecFileSync = (file: string, args: string[], options: { encoding: "utf8"; windowsHide: boolean; timeout: number }) => string;

export type AclDeps = {
  execFileSync?: ExecFileSync;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** The current user as a SID or DOMAIN\name. Default: the SID from whoami, else USERDOMAIN\USERNAME. */
  user?: string;
  warn?: (message: string) => void;
};

// Well-known SIDs, so the grants work on non-English Windows.
const SYSTEM_SID = "*S-1-5-18";
const ADMINISTRATORS_SID = "*S-1-5-32-544";

/**
 * Windows only: makes `dir` private. mkdtemp's mode is ignored there and the folder inherits %TEMP%'s ACL, which on some
 * PCs grants other principals; agent-desktop then refuses the state folder ("private file DACL grants an untrusted
 * principal"). Grants full control (inherited by files and subfolders) to the current user, SYSTEM and Administrators only,
 * then removes inherited entries. Warns, never throws. Returns whether the ACL is locked and checked.
 */
export function lockPrivateStateDirAcl(dir: string, deps: AclDeps = {}): boolean {
  if ((deps.platform ?? process.platform) !== "win32") return true;
  const env = deps.env ?? process.env;
  const run = deps.execFileSync ?? (execFileSync as unknown as ExecFileSync);
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  // Full paths, so a folder on PATH cannot stand in for the system tools.
  const system32 = win32.join(env.SystemRoot ?? env.windir ?? "C:\\Windows", "System32");
  const options = { encoding: "utf8" as const, windowsHide: true, timeout: 10_000 };
  try {
    const user = deps.user ?? currentUserSid(run, win32.join(system32, "whoami.exe"), options) ?? accountName(env);
    if (!user) throw new Error("current user unknown");
    const icacls = win32.join(system32, "icacls.exe");
    // Grant first, then drop inheritance, so the folder is never left with no entry for the user.
    run(icacls, [dir, "/grant:r", `${SYSTEM_SID}:(OI)(CI)F`, `${ADMINISTRATORS_SID}:(OI)(CI)F`, `${user}:(OI)(CI)F`], options);
    run(icacls, [dir, "/inheritance:r"], options);
    const entries = aclEntries(run(icacls, [dir], options), dir);
    // Names in the listing are localised, so check the shape: no inherited entries, and only the three grants.
    if (entries.length === 0 || entries.length > 3 || entries.some((entry) => entry.includes("(I)"))) {
      throw new Error(`unexpected ACL (${entries.length} entries)`);
    }
    return true;
  } catch (error) {
    warn(`agent-desktop: could not make the state folder private; commands may fail. ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function currentUserSid(run: ExecFileSync, whoami: string, options: Parameters<ExecFileSync>[2]): string | null {
  try {
    const sid = /"(S-1-[\d-]+)"/.exec(run(whoami, ["/user", "/fo", "csv", "/nh"], options))?.[1];
    return sid ? `*${sid}` : null;
  } catch {
    return null;
  }
}

function accountName(env: NodeJS.ProcessEnv): string | null {
  if (!env.USERNAME) return null;
  return env.USERDOMAIN ? `${env.USERDOMAIN}\\${env.USERNAME}` : env.USERNAME;
}

/** The ACE lines from `icacls <dir>`: the first is prefixed by the path; a blank line comes before the summary. */
function aclEntries(output: string, dir: string): string[] {
  const text = output.replace(/\r/g, "");
  const start = text.indexOf(dir);
  const lines = (start >= 0 ? text.slice(start + dir.length) : text).split("\n");
  const entries: string[] = [];
  for (const line of lines) {
    if (!line.trim()) break;
    entries.push(line.trim());
  }
  return entries;
}

/**
 * One command at a time. agent-desktop keeps snapshot ref maps under AGENT_DESKTOP_HOME; Bee points it at a private
 * temporary folder instead of ~/.agent-desktop, and deletes it when reading stops and at quit. Private means mode 0700 on
 * macOS and Linux (mkdtemp's default), and on Windows an ACL for the user, SYSTEM and Administrators only (lockPrivateStateDirAcl).
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
  const exec: ExecFile = deps.exec ?? execWithStdin;
  let home: string | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const ensureHome = (): string => {
    if (home) return home;
    const dir = mkdtempSync(join(deps.tempDir?.() ?? tmpdir(), "bee-agent-desktop-"));
    (deps.lockAcl ?? lockPrivateStateDirAcl)(dir);
    home = dir;
    return home;
  };

  const spawn = (command: C, args: string[], timeoutMs: number, signal?: AbortSignal, stdin?: string): Promise<AgentDesktopResult> =>
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
        const options = {
          timeout: timeoutMs,
          maxBuffer: MAX_BUFFER,
          windowsHide: true,
          env: childEnv(deps.env ?? process.env, dir, binary.macHelper),
          encoding: "utf8" as const,
          ...(stdin !== undefined ? { stdin } : {}),
        };
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
    run: (command: C, args: string[], options: ComputerRunOptions = {}): Promise<AgentDesktopResult> => {
      // Throws on anything outside the runner's set, before a process starts.
      allow(command, args);
      // stdin goes with --stdin and only with it (assertComputerUse lets type and set-value take it): --stdin with no text would
      // leave the child waiting on an open pipe until the timeout.
      const dash = args.indexOf("--");
      if ((dash < 0 ? args : args.slice(0, dash)).includes(STDIN_FLAG) !== (options.stdin !== undefined)) throw new Error("agent-desktop --stdin needs stdin text");
      const result = queue.then(() => spawn(command, args, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.signal, options.stdin));
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
