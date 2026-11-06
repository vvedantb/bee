import type { Dirent } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { AgentDesktopResult, DesktopActionCommand } from "../core/agent-desktop-envelope";
import { createDesktopActions, findShortcut, startMenuShortcuts, windowsStartMenuDirs, type DesktopActionDeps } from "./desktop-actions";
import { resolveApp } from "../core/desktop-actions";

// Desktop actions in main with every OS call faked: agent-desktop's action runner, execFile, and Electron's shell.

type RunCall = { command: DesktopActionCommand; args: string[] };

const entry = (name: string, kind: "file" | "dir"): Dirent => ({ name, isDirectory: () => kind === "dir", isFile: () => kind === "file" }) as unknown as Dirent;

// A Start menu: Slack and Zoom in folders, Word at the top, an uninstaller beside Zoom.
const START = join("C:", "Users", "v", "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs");
const TREE: Record<string, Dirent[]> = {
  [START]: [entry("Word.lnk", "file"), entry("Slack Technologies Inc", "dir"), entry("Zoom", "dir"), entry("desktop.ini", "file")],
  [join(START, "Slack Technologies Inc")]: [entry("Slack.lnk", "file")],
  [join(START, "Zoom")]: [entry("Uninstall Zoom.lnk", "file"), entry("Zoom Workplace.lnk", "file")],
};
const readDir = (dir: string): Dirent[] => {
  const found = TREE[dir];
  if (!found) throw new Error("ENOENT");
  return found;
};

function make(platform: NodeJS.Platform, options: { running?: string[]; adMissing?: boolean; failOpen?: boolean; failUri?: boolean; failFocus?: boolean; failLaunch?: boolean } = {}) {
  const runs: RunCall[] = [];
  const execs: Array<{ file: string; args: string[] }> = [];
  const external: string[] = [];
  const paths: string[] = [];
  const run = async (command: DesktopActionCommand, args: string[]): Promise<AgentDesktopResult> => {
    runs.push({ command, args });
    if (command === "list-apps") return { ok: true, data: { apps: (options.running ?? []).map((name, index) => ({ name, pid: index + 1 })) } };
    if (command === "focus-window") return options.failFocus ? { ok: false, code: "ACTION_FAILED" } : { ok: true, data: {} };
    return options.failLaunch ? { ok: false, code: "APP_NOT_FOUND" } : { ok: true, data: {} };
  };
  const deps: DesktopActionDeps = {
    platform,
    run: options.adMissing ? null : run,
    execFile: async (file, args) => {
      execs.push({ file, args });
      if (options.failOpen) throw new Error("Unable to find application");
    },
    openExternal: async (url) => {
      if (options.failUri && !url.startsWith("http")) throw new Error("no handler");
      external.push(url);
    },
    openPath: async (path) => {
      paths.push(path);
      return "";
    },
    startMenuDirs: [START, join("C:", "ProgramData", "missing")],
    readDir,
  };
  return { actions: createDesktopActions(deps), runs, execs, external, paths };
}

describe("desktop actions on macOS", () => {
  it("opens an app with /usr/bin/open -a and the app's display name, as fixed arguments", async () => {
    const { actions, execs, runs } = make("darwin");
    expect(await actions.openApp("teams")).toEqual({ ok: true, message: "Opened Teams" });
    expect(await actions.openApp("Figma")).toEqual({ ok: true, message: "Opened Figma" });
    expect(execs).toEqual([
      { file: "/usr/bin/open", args: ["-a", "Microsoft Teams"] },
      { file: "/usr/bin/open", args: ["-a", "Figma"] },
    ]);
    expect(runs).toEqual([]);
  });

  it("falls back to agent-desktop launch --activate when open -a cannot find it, then says so", async () => {
    const found = make("darwin", { failOpen: true });
    expect(await found.actions.openApp("Slack")).toEqual({ ok: true, message: "Opened Slack" });
    expect(found.runs).toEqual([{ command: "launch", args: ["Slack", "--activate", "--timeout", "8000"] }]);
    const missing = make("darwin", { failOpen: true, failLaunch: true });
    expect(await missing.actions.openApp("Figma")).toEqual({ ok: false, message: "Could not find Figma" });
    const noBinary = make("darwin", { failOpen: true, adMissing: true });
    expect(await noBinary.actions.openApp("Figma")).toEqual({ ok: false, message: "Could not find Figma" });
  });

  it("brings an app forward with open -a, and one window by title with agent-desktop focus-window", async () => {
    const plain = make("darwin");
    expect(await plain.actions.focusWindow({ app: "Teams" })).toEqual({ ok: true, message: "Focused Teams" });
    expect(plain.execs).toEqual([{ file: "/usr/bin/open", args: ["-a", "Microsoft Teams"] }]);
    const titled = make("darwin", { running: ["Microsoft Teams"] });
    expect(await titled.actions.focusWindow({ app: "Teams", title: "Weekly standup" })).toEqual({ ok: true, message: "Focused Teams" });
    expect(titled.runs).toEqual([
      { command: "list-apps", args: [] },
      { command: "focus-window", args: ["--app", "Microsoft Teams", "--title", "Weekly standup"] },
    ]);
  });

  it("refuses shells and paths before anything runs", async () => {
    const { actions, execs, runs } = make("darwin");
    expect(await actions.openApp("Terminal")).toEqual({ ok: false, message: "Bee does not open terminals, script tools or system tools" });
    expect((await actions.openApp("/Applications/Evil.app")).ok).toBe(false);
    expect((await actions.openApp("-n")).ok).toBe(false);
    expect((await actions.focusWindow({ app: "Teams", title: "--headed" })).ok).toBe(false);
    expect(execs).toEqual([]);
    expect(runs).toEqual([]);
  });
});

describe("desktop actions on Windows", () => {
  it("brings a running app forward with agent-desktop focus-window, by the name list-apps gave", async () => {
    const { actions, runs, external } = make("win32", { running: ["Slack", "Microsoft Teams"] });
    expect(await actions.openApp("teams")).toEqual({ ok: true, message: "Opened Teams" });
    expect(runs).toEqual([
      { command: "list-apps", args: [] },
      { command: "focus-window", args: ["--app", "Microsoft Teams"] },
    ]);
    expect(external).toEqual([]);
  });

  it("opens Teams by its fixed URI when it is not running", async () => {
    const { actions, external, paths } = make("win32");
    expect(await actions.openApp("Microsoft Teams")).toEqual({ ok: true, message: "Opened Teams" });
    expect(external).toEqual(["msteams:"]);
    expect(paths).toEqual([]);
  });

  it("opens other apps by their Start menu shortcut, exact name first, never an uninstaller", async () => {
    const { actions, paths, external } = make("win32", { adMissing: true });
    expect(await actions.openApp("slack")).toEqual({ ok: true, message: "Opened Slack" });
    expect(await actions.openApp("Zoom")).toEqual({ ok: true, message: "Opened Zoom" });
    expect(await actions.openApp("word")).toEqual({ ok: true, message: "Opened Word" });
    expect(paths).toEqual([join(START, "Slack Technologies Inc", "Slack.lnk"), join(START, "Zoom", "Zoom Workplace.lnk"), join(START, "Word.lnk")]);
    expect(external).toEqual([]);
  });

  it("launches only a fixed system exe through agent-desktop, and says when nothing is found", async () => {
    const { actions, runs } = make("win32");
    expect(await actions.openApp("Notepad")).toEqual({ ok: true, message: "Opened Notepad" });
    expect(runs.at(-1)).toEqual({ command: "launch", args: ["notepad.exe"] });
    // A name Bee does not know is never passed to launch: only the Start menu is searched.
    const before = runs.length;
    expect(await actions.openApp("Figma")).toEqual({ ok: false, message: "Could not find Figma" });
    expect(runs.slice(before).map((call) => call.command)).toEqual(["list-apps"]);
  });

  it("falls back from a failed URI to the Start menu, and says when that finds nothing", async () => {
    const { actions, paths } = make("win32", { failUri: true, adMissing: true });
    expect(await actions.openApp("Spotify")).toEqual({ ok: false, message: "Could not find Spotify" });
    expect(paths).toEqual([]);
  });

  it("focuses a window by title, or opens the app when focus fails", async () => {
    const running = make("win32", { running: ["Microsoft Teams"] });
    expect(await running.actions.focusWindow({ app: "Teams", title: "Standup" })).toEqual({ ok: true, message: "Focused Teams" });
    expect(running.runs.at(-1)).toEqual({ command: "focus-window", args: ["--app", "Microsoft Teams", "--title", "Standup"] });
    const stuck = make("win32", { running: ["Microsoft Teams"], failFocus: true });
    expect(await stuck.actions.focusWindow({ app: "Teams" })).toEqual({ ok: true, message: "Opened Teams" });
    expect(stuck.external).toEqual(["msteams:"]);
  });

  it("reads the Start menu folders from the environment", () => {
    expect(windowsStartMenuDirs({ APPDATA: "C:\\Users\\v\\AppData\\Roaming", ProgramData: "C:\\ProgramData" })).toEqual([
      join("C:\\Users\\v\\AppData\\Roaming", "Microsoft", "Windows", "Start Menu", "Programs"),
      join("C:\\ProgramData", "Microsoft", "Windows", "Start Menu", "Programs"),
    ]);
    expect(windowsStartMenuDirs({})).toEqual([]);
  });
});

describe("startMenuShortcuts and findShortcut", () => {
  it("lists .lnk files in subfolders and skips the rest", () => {
    expect(startMenuShortcuts([START], readDir).map((shortcut) => shortcut.name)).toEqual(["Word", "Slack", "Uninstall Zoom", "Zoom Workplace"]);
  });

  it("matches exactly, then by the shortest prefix", () => {
    const shortcuts = [
      { name: "Microsoft Teams (work or school)", path: "a" },
      { name: "Teams Machine-Wide Installer Help", path: "b" },
      { name: "Outlook (classic)", path: "c" },
    ];
    const teams = resolveApp("Teams");
    const outlook = resolveApp("Outlook");
    if (!teams.ok || !outlook.ok) throw new Error("resolve");
    expect(findShortcut(teams.app, shortcuts)).toBe("a");
    expect(findShortcut(outlook.app, shortcuts)).toBe("c");
  });
});

describe("desktop actions everywhere", () => {
  let debug: MockInstance<typeof console.debug>;
  beforeEach(() => {
    debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
  });
  afterEach(() => debug.mockRestore());

  it("opens only safe http and https pages, with tracking removed", async () => {
    const { actions, external } = make("darwin");
    expect(await actions.openUrl("https://www.bbc.co.uk/news?utm_source=x")).toEqual({ ok: true, message: "Opened https://www.bbc.co.uk/news" });
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "http://localhost:3000", "msteams:", "https://user:pw@example.com", "not a url"]) {
      expect(await actions.openUrl(url), url).toEqual({ ok: false, message: "Bee opens only http and https web pages" });
    }
    expect(external).toEqual(["https://www.bbc.co.uk/news"]);
  });

  it("says apps and windows open on Windows, Mac and Linux only elsewhere", async () => {
    const { actions, execs, runs } = make("freebsd");
    expect(await actions.openApp("Teams")).toEqual({ ok: false, message: "Bee opens apps on Windows, Mac and Linux only" });
    expect(await actions.focusWindow({ app: "Teams" })).toEqual({ ok: false, message: "Bee switches windows on Windows, Mac and Linux only" });
    expect(execs).toEqual([]);
    expect(runs).toEqual([]);
  });

  it("logs codes only, never app names or titles", async () => {
    const { actions } = make("win32", { running: ["Microsoft Teams"], failFocus: true, failUri: true, failLaunch: true });
    await actions.focusWindow({ app: "Teams", title: "Secret board meeting" });
    const logged = debug.mock.calls.flat().join(" ");
    expect(logged).toContain("focus-window ACTION_FAILED");
    expect(logged).not.toMatch(/Teams|Secret/);
  });
});

// Linux: agent-desktop launch by desktop-entry name, list-apps and focus-window, all faked. A launch result per name, a list-apps
// result per call (the last repeats), and focus-window refusing as it does on Wayland.
function makeLinux(options: { launch?: Record<string, AgentDesktopResult>; lists?: AgentDesktopResult[]; focus?: AgentDesktopResult } = {}) {
  const runs: RunCall[] = [];
  const execs: string[] = [];
  let listCall = 0;
  const run = async (command: DesktopActionCommand, args: string[]): Promise<AgentDesktopResult> => {
    runs.push({ command, args });
    if (command === "list-apps") {
      const lists = options.lists ?? [{ ok: true, data: { apps: [] } }];
      return lists[Math.min(listCall++, lists.length - 1)] as AgentDesktopResult;
    }
    if (command === "focus-window") return options.focus ?? { ok: false, code: "ACTION_NOT_SUPPORTED" };
    return options.launch?.[args[0] ?? ""] ?? { ok: false, code: "APP_NOT_FOUND" };
  };
  const actions = createDesktopActions({
    platform: "linux",
    run,
    execFile: async (file) => {
      execs.push(file);
    },
    openExternal: async () => undefined,
    openPath: async () => "",
  });
  return { actions, runs, execs, launched: () => runs.filter((call) => call.command === "launch").map((call) => call.args[0]) };
}
const apps = (...names: string[]): AgentDesktopResult => ({ ok: true, data: { apps: names.map((name, index) => ({ name, pid: index + 1 })) } });

describe("desktop actions on Linux", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => vi.useRealTimers());

  it("opens a cold app by its desktop-entry names in turn, waiting for its window, never through a shell", async () => {
    const { actions, launched, runs, execs } = makeLinux({ launch: { chromium: { ok: true, data: {} } } });
    expect(await actions.openApp("Chrome")).toEqual({ ok: true, message: "Opened Chrome" });
    expect(launched()).toEqual(["google-chrome", "google-chrome-stable", "chromium"]);
    expect(runs.find((call) => call.command === "launch")?.args).toEqual(["google-chrome", "--activate", "--timeout", "8000"]);
    expect(execs).toEqual([]);
  });

  it("brings a warm app forward with focus-window, with no launch (X11)", async () => {
    const { actions, launched } = makeLinux({ lists: [apps("google-chrome")], focus: { ok: true, data: {} } });
    expect(await actions.openApp("Chrome")).toEqual({ ok: true, message: "Opened Chrome" });
    expect(launched()).toEqual([]);
  });

  it("falls back to launch --activate when focus-window is refused (Wayland)", async () => {
    const { actions, launched } = makeLinux({ lists: [apps("google-chrome")], launch: { "google-chrome": { ok: true, data: {} } } });
    expect(await actions.focusWindow({ app: "Chrome" })).toEqual({ ok: true, message: "Opened Chrome" });
    expect(launched()).toEqual(["google-chrome"]);
  });

  it("looks for a cold app that timed out, a few times, rather than start another browser", async () => {
    const { actions, launched, runs } = makeLinux({
      launch: { "google-chrome": { ok: false, code: "TIMEOUT" } },
      lists: [apps(), apps(), apps("google-chrome")],
    });
    const result = actions.openApp("Chrome");
    await vi.runAllTimersAsync();
    expect(await result).toEqual({ ok: true, message: "Opened Chrome" });
    expect(launched()).toEqual(["google-chrome"]);
    // One warm check before launching, then two misses and a hit while it starts.
    expect(runs.filter((call) => call.command === "list-apps")).toHaveLength(3);
  });

  it("stops waiting for a cold app when the request is stopped or superseded (PR #80 review)", async () => {
    const { actions, launched, runs } = makeLinux({ launch: { "google-chrome": { ok: false, code: "TIMEOUT" } }, lists: [apps()] });
    const stop = new AbortController();
    const result = actions.openApp("Chrome", stop.signal);
    // The warm check, the launch that timed out and the first look run; then Stop lands during the pause.
    await vi.advanceTimersByTimeAsync(0);
    expect(runs.filter((call) => call.command === "list-apps")).toHaveLength(2);
    stop.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toEqual({ ok: false, message: "Stopped before Chrome opened" });
    // No look after the stop, and no other name launched.
    expect(runs.filter((call) => call.command === "list-apps")).toHaveLength(2);
    expect(launched()).toEqual(["google-chrome"]);
  });

  it("never starts a launch or a look for a request already stopped", async () => {
    const { actions, runs } = makeLinux({ launch: { "google-chrome": { ok: true, data: {} } } });
    expect(await actions.openApp("Chrome", AbortSignal.abort())).toEqual({ ok: false, message: "Stopped before Chrome opened" });
    expect(await actions.focusWindow({ app: "Chrome" }, AbortSignal.abort())).toEqual({ ok: false, message: "Stopped before Chrome came forward" });
    expect(runs).toEqual([]);
  });

  it("says no accessibility bus plainly, and stops trying names", async () => {
    const { actions, launched } = makeLinux({ lists: [{ ok: false, code: "PLATFORM_NOT_SUPPORTED" }] });
    expect(await actions.openApp("Chrome")).toEqual({ ok: false, message: "Could not open Chrome: Bee cannot reach the desktop session's accessibility bus" });
    expect(launched()).toEqual([]);
    const denied = makeLinux({ launch: { "google-chrome": { ok: false, code: "PERM_DENIED" } } });
    expect(await denied.actions.openApp("Chrome")).toMatchObject({ ok: false, message: expect.stringContaining("accessibility bus") });
    expect(denied.launched()).toEqual(["google-chrome"]);
  });

  it("says not found when no name launches, and still opens pages", async () => {
    const { actions, launched } = makeLinux();
    expect(await actions.openApp("Figma")).toEqual({ ok: false, message: "Could not find Figma" });
    expect(launched()).toEqual(["Figma", "figma"]);
    expect(await actions.openUrl("https://example.com/")).toEqual({ ok: true, message: "Opened https://example.com/" });
  });
});
