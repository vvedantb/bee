import { execFile } from "node:child_process";
import { readdirSync, type Dirent } from "node:fs";
import { basename, extname, join } from "node:path";
import { parseApps, type AdApp } from "../core/agent-desktop-envelope";
import { afterLaunchFailure, linuxLaunchNames, waitForListed } from "../core/app-discovery";
import {
  cleanWindowTitle,
  matchRunningApp,
  openedUrlMessage,
  resolveApp,
  type AppTarget,
  type DesktopActionResult,
  type DesktopActions,
} from "../core/desktop-actions";
import { safeExternalUrl } from "../core/url-safety";
import { withoutSecrets, type AgentDesktopActionRun } from "./agent-desktop";

// Bee's desktop tools in main: open or bring forward an app or a window, and open a web page, for a direct request only
// ("Bee, open Teams"). No Electron imports: index.ts passes shell.openExternal and shell.openPath. Nothing here runs a shell.
// Processes start with execFile and fixed arguments: macOS /usr/bin/open -a <a checked app name>, and agent-desktop through its
// own action runner (launch, focus-window, list-apps only). Windows apps open by a fixed URI, a Start menu shortcut or a fixed
// system exe. Linux apps open through agent-desktop launch by desktop-entry name (google-chrome, then chromium, …), which needs
// the desktop session's accessibility bus; a launch that times out is looked for in list-apps before Bee calls it missing
// (core/app-discovery.ts). Console lines carry codes only, never names.

export type DesktopActionDeps = {
  platform: NodeJS.Platform;
  /** agent-desktop's action runner, or null when the binary is missing. Never the meeting window reader's runner. */
  run: AgentDesktopActionRun | null;
  /** Runs a program with fixed arguments, no shell. Resolves on exit 0, rejects otherwise. */
  execFile?: (file: string, args: string[]) => Promise<void>;
  /** Electron shell.openExternal: http(s) pages and fixed app URIs (msteams:). */
  openExternal: (url: string) => Promise<void>;
  /** Electron shell.openPath: "" on success, else an error message. Only ever a Start menu shortcut here. */
  openPath: (path: string) => Promise<string>;
  /** Windows: the user's and all users' Start menu Programs folders. */
  startMenuDirs?: readonly string[];
  /** Lists a folder (tests pass a fake). */
  readDir?: (dir: string) => Dirent[];
};

const MAC_OPEN = "/usr/bin/open";
const EXEC_TIMEOUT_MS = 10_000;
const LAUNCH_TIMEOUT_MS = 8000;
const LIST_TIMEOUT_MS = 6000;
// Start menu folders are small, but a cap keeps a huge one from stalling the action.
const MAX_SHORTCUTS = 3000;
const MAX_DEPTH = 3;
const NOT_APPS = /\b(?:uninstall|readme|read me|help|documentation|release notes|website|license|manual)\b/i;

/** execFile with fixed arguments, no shell, a timeout and no secrets in the environment. */
function execFixed(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: EXEC_TIMEOUT_MS, windowsHide: true, env: withoutSecrets(process.env), shell: false }, (error) => (error ? reject(error) : resolve()));
  });
}

/** Start menu shortcuts (.lnk) under the folders, by name without the extension. Hidden and odd entries are skipped. */
export function startMenuShortcuts(dirs: readonly string[], readDir: (dir: string) => Dirent[] = (dir) => readdirSync(dir, { withFileTypes: true })): { name: string; path: string }[] {
  const found: { name: string; path: string }[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH || found.length >= MAX_SHORTCUTS) return;
    let entries: Dirent[];
    try {
      entries = readDir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= MAX_SHORTCUTS || entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.isFile() && extname(entry.name).toLowerCase() === ".lnk") found.push({ name: basename(entry.name, extname(entry.name)), path });
    }
  };
  for (const dir of dirs) walk(dir, 0);
  return found;
}

/** The shortcut for the app: an exact name first, then the shortest that starts with one ("Zoom" → "Zoom Workplace"). */
export function findShortcut(app: AppTarget, shortcuts: readonly { name: string; path: string }[]): string | null {
  const names = (app.win?.startMenu ?? []).map((name) => name.toLowerCase());
  const usable = shortcuts.filter((shortcut) => !NOT_APPS.test(shortcut.name));
  for (const name of names) {
    const exact = usable.find((shortcut) => shortcut.name.toLowerCase() === name);
    if (exact) return exact.path;
  }
  const prefixed = usable
    .filter((shortcut) => names.some((name) => name.length >= 3 && shortcut.name.toLowerCase().startsWith(`${name} `)))
    .sort((a, b) => a.name.length - b.name.length);
  return prefixed[0]?.path ?? null;
}

/** Windows: the user's and all users' Start menu Programs folders, from the environment. */
export function windowsStartMenuDirs(env: NodeJS.ProcessEnv): string[] {
  const programs = (root: string | undefined) => (root ? [join(root, "Microsoft", "Windows", "Start Menu", "Programs")] : []);
  return [...programs(env.APPDATA), ...programs(env.ProgramData ?? env.PROGRAMDATA)];
}

const ok = (message: string): DesktopActionResult => ({ ok: true, message });
const fail = (message: string): DesktopActionResult => ({ ok: false, message });

export function createDesktopActions(deps: DesktopActionDeps): DesktopActions {
  const runFixed = deps.execFile ?? execFixed;
  const run = deps.run;

  // Linux: agent-desktop said there is no accessibility bus (no D-Bus session). Every launch fails the same way until restart.
  let noBus = false;

  // A run that the request's signal (Stop, a newer request) stops, in flight or before it starts.
  const options = (timeoutMs: number, signal?: AbortSignal) => (signal ? { timeoutMs, signal } : { timeoutMs });

  /** The running app that matches, from agent-desktop list-apps. Null when none does or agent-desktop cannot tell. */
  async function runningApp(app: AppTarget, signal?: AbortSignal): Promise<AdApp | null> {
    if (!run || signal?.aborted) return null;
    const listed = await run("list-apps", [], options(LIST_TIMEOUT_MS, signal));
    if (!listed.ok) {
      console.debug(`desktop-action list-apps ${listed.code}`);
      if (deps.platform === "linux" && afterLaunchFailure(listed.code) === "stop") noBus = true;
      return null;
    }
    return matchRunningApp(app, parseApps(listed.data));
  }

  /** agent-desktop focus-window for a running app's own name, optionally one window by title. */
  async function focusRunning(app: AppTarget, title: string | null, signal?: AbortSignal): Promise<boolean> {
    if (!run) return false;
    const running = await runningApp(app, signal);
    if (!running || signal?.aborted) return false;
    const focused = await run("focus-window", ["--app", running.name, ...(title ? ["--title", title] : [])], options(LIST_TIMEOUT_MS, signal));
    if (!focused.ok) console.debug(`desktop-action focus-window ${focused.code}`);
    return focused.ok;
  }

  /** macOS: open -a opens the app, or brings it forward if it is running. agent-desktop launch also takes bundle ids. */
  async function openMac(app: AppTarget): Promise<boolean> {
    if (!app.mac) return false;
    try {
      await runFixed(MAC_OPEN, ["-a", app.mac]);
      return true;
    } catch {
      console.debug("desktop-action open-a failed");
    }
    if (!run) return false;
    const launched = await run("launch", [app.mac, "--activate", "--timeout", String(LAUNCH_TIMEOUT_MS)], { timeoutMs: LAUNCH_TIMEOUT_MS + 2000 });
    if (!launched.ok) console.debug(`desktop-action launch ${launched.code}`);
    return launched.ok;
  }

  /** Windows: the app's fixed URI, then its Start menu shortcut, then its fixed system exe. Never a name from the model as a command. */
  async function openWindows(app: AppTarget): Promise<boolean> {
    const win = app.win;
    if (!win) return false;
    if (win.uri) {
      try {
        await deps.openExternal(win.uri);
        return true;
      } catch {
        console.debug("desktop-action uri failed");
      }
    }
    const shortcut = findShortcut(app, startMenuShortcuts(deps.startMenuDirs ?? [], deps.readDir));
    if (shortcut && (await deps.openPath(shortcut).catch(() => "failed")) === "") return true;
    if (win.exe && run) {
      const launched = await run("launch", [win.exe], { timeoutMs: LAUNCH_TIMEOUT_MS });
      if (!launched.ok) console.debug(`desktop-action launch ${launched.code}`);
      return launched.ok;
    }
    return false;
  }

  /**
   * Linux: agent-desktop launch by each desktop-entry name in turn (--activate waits for a window, so a warm app comes forward).
   * A launch that timed out may be a cold app still starting: Bee looks for it in list-apps a few times rather than start
   * another name. No accessibility bus: stops at once. The signal (Stop, a newer request) ends the launches and the looks: the
   * pauses between looks end early, and no further launch or look starts.
   */
  async function openLinux(app: AppTarget, signal?: AbortSignal): Promise<boolean> {
    if (!run) return false;
    for (const name of linuxLaunchNames(app)) {
      if (signal?.aborted) return false;
      const launched = await run("launch", [name, "--activate", "--timeout", String(LAUNCH_TIMEOUT_MS)], options(LAUNCH_TIMEOUT_MS + 2000, signal));
      if (launched.ok) return true;
      console.debug(`desktop-action launch ${launched.code}`);
      if (signal?.aborted) return false;
      const next = afterLaunchFailure(launched.code);
      if (next === "stop") {
        noBus = true;
        return false;
      }
      if (next === "look") return (await waitForListed({ list: () => runningApp(app, signal), ...(signal ? { signal } : {}) })).found !== null;
    }
    return false;
  }

  async function open(app: AppTarget, signal?: AbortSignal): Promise<boolean> {
    if (deps.platform === "darwin") return openMac(app);
    if (deps.platform === "win32") {
      // Already running: bring it forward rather than start another copy.
      if (await focusRunning(app, null, signal)) return true;
      if (signal?.aborted) return false;
      return openWindows(app);
    }
    if (deps.platform === "linux") {
      // Already running and focusable (X11): bring it forward. On Wayland focus-window refuses, and launch --activate does it.
      if (await focusRunning(app, null, signal)) return true;
      if (noBus) return false;
      return openLinux(app, signal);
    }
    return false;
  }

  const unsupported = () => deps.platform !== "darwin" && deps.platform !== "win32" && deps.platform !== "linux";
  /** Why an app did not open: on Linux with no accessibility bus, that; otherwise not found. */
  const notOpened = (app: AppTarget, what = "") =>
    fail(noBus ? `Could not open ${app.label}: Bee cannot reach the desktop session's accessibility bus` : `Could not find ${what}${app.label}`);

  return {
    async openApp(name, signal) {
      const resolved = resolveApp(name);
      if (!resolved.ok) return fail(resolved.message);
      if (unsupported()) return fail("Bee opens apps on Windows, Mac and Linux only");
      const { app } = resolved;
      if (await open(app, signal)) return ok(`Opened ${app.label}`);
      return signal?.aborted ? fail(`Stopped before ${app.label} opened`) : notOpened(app);
    },

    async focusWindow({ app: name, title: rawTitle }, signal) {
      const resolved = resolveApp(name);
      if (!resolved.ok) return fail(resolved.message);
      if (unsupported()) return fail("Bee switches windows on Windows, Mac and Linux only");
      const { app } = resolved;
      const title = rawTitle === undefined ? null : cleanWindowTitle(rawTitle);
      if (rawTitle !== undefined && rawTitle.trim() !== "" && !title) return fail("That is not a window title Bee can use");
      // macOS without a title: open -a brings the app's windows forward. Otherwise agent-desktop focuses one window.
      if (deps.platform === "darwin" && !title) return (await openMac(app)) ? ok(`Focused ${app.label}`) : fail(`Could not find ${app.label}`);
      if (await focusRunning(app, title, signal)) return ok(`Focused ${app.label}`);
      if (signal?.aborted) return fail(`Stopped before ${app.label} came forward`);
      // Not running, or agent-desktop could not focus it (on Linux, a Wayland session): opening it brings it forward.
      const opened = deps.platform === "darwin" ? await openMac(app) : deps.platform === "linux" ? !noBus && (await openLinux(app, signal)) : await openWindows(app);
      if (opened) return ok(`Opened ${app.label}`);
      return signal?.aborted ? fail(`Stopped before ${app.label} came forward`) : notOpened(app, "a window for ");
    },

    async openUrl(raw) {
      const url = safeExternalUrl(raw);
      if (!url) return fail("Bee opens only http and https web pages");
      try {
        await deps.openExternal(url);
        return ok(openedUrlMessage(url));
      } catch {
        return fail("Could not open that page");
      }
    },
  };
}
