import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertReadOnly, parseEnvelope, type AgentDesktopResult, type ReadOnlyCommand } from "../core/agent-desktop-envelope";

// Runs the agent-desktop CLI (npm agent-desktop, Apache-2.0) for the experimental meeting window reader. Read-only commands
// only (assertReadOnly), always headless (never --headed), one at a time, each with a timeout. stdout is parsed and dropped:
// nothing it holds is logged. Spawn failures come back as codes, never as throws.

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
  options: { timeout: number; maxBuffer: number; windowsHide: boolean; env: NodeJS.ProcessEnv; encoding: "utf8" },
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

/**
 * One command at a time. agent-desktop keeps snapshot ref maps under AGENT_DESKTOP_HOME; Bee points it at a private
 * temporary folder (mode 0700) instead of ~/.agent-desktop, and deletes it when reading stops and at quit.
 */
export function createAgentDesktopRunner(binary: AgentDesktopBinary, deps: { exec?: ExecFile; env?: NodeJS.ProcessEnv; tempDir?: () => string } = {}): AgentDesktopRunner {
  const exec: ExecFile = deps.exec ?? (execFile as unknown as ExecFile);
  let home: string | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const ensureHome = (): string => {
    home ??= mkdtempSync(join(deps.tempDir?.() ?? tmpdir(), "bee-agent-desktop-"));
    return home;
  };

  const spawn = (command: ReadOnlyCommand, args: string[], timeoutMs: number): Promise<AgentDesktopResult> =>
    new Promise((resolve) => {
      let dir: string;
      try {
        dir = ensureHome();
      } catch {
        resolve({ ok: false, code: "SPAWN_FAILED" });
        return;
      }
      try {
        exec(binary.path, [command, ...args], { timeout: timeoutMs, maxBuffer: MAX_BUFFER, windowsHide: true, env: childEnv(deps.env ?? process.env, dir, binary.macHelper), encoding: "utf8" }, (error, stdout) => {
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
    run: (command, args, options = {}) => {
      // Throws on anything outside the read-only set, before a process starts.
      assertReadOnly(command, args);
      const result = queue.then(() => spawn(command, args, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
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
