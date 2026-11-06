import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDesktopResult, ComputerRun, ComputerUseCommand } from "./agent-desktop-envelope";
import { COLD_START_MS, LISTED_TRIES, LISTED_TRIES_SLOW, afterLaunchFailure, isColdStart, linuxLaunchNames, listedTries, runningAppsLine, waitForListed } from "./app-discovery";
import { createRunControl } from "./computer-control";
import { computerTools } from "./computer-tools";
import type { DesktopActions } from "./desktop-actions";

// Cold vs warm app discovery: the pure helpers, then the computer tools over a fake agent-desktop where a just-opened app is
// not listed at first. Synthetic app names only (a Chrome-like browser and a fixture app); no Teams.

describe("app discovery helpers", () => {
  it("counts an app as starting only within COLD_START_MS of opening it", () => {
    expect(isColdStart(undefined, 1000)).toBe(false);
    expect(isColdStart(1000, 1000 + COLD_START_MS)).toBe(true);
    expect(isColdStart(1000, 1001 + COLD_START_MS)).toBe(false);
    expect(isColdStart(5000, 1000)).toBe(false);
  });

  it("looks again with a pause until the app shows, under a cap", async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    let looks = 0;
    const found = await waitForListed({ list: async () => (++looks >= 3 ? "google-chrome" : null), sleep, delayMs: 10 });
    expect(found).toEqual({ found: "google-chrome", tries: 3 });
    expect(sleeps).toEqual([10, 10]);
    const missing = await waitForListed({ list: async () => null, sleep });
    expect(missing).toEqual({ found: null, tries: LISTED_TRIES });
    expect(sleeps).toHaveLength(2 + LISTED_TRIES - 1);
  });

  it("stops looking once the signal aborts", async () => {
    const stop = new AbortController();
    let looks = 0;
    const found = await waitForListed({ list: async () => (++looks === 1 ? (stop.abort(), null) : "x"), signal: stop.signal, sleep: async () => undefined });
    expect(found).toEqual({ found: null, tries: 1 });
  });

  it("tells a launch that may still be starting from one that cannot work, or a name to skip", () => {
    expect(afterLaunchFailure("TIMEOUT")).toBe("look");
    expect(afterLaunchFailure("TIMEOUT_LOCAL")).toBe("look");
    expect(afterLaunchFailure("PERM_DENIED")).toBe("stop");
    expect(afterLaunchFailure("PLATFORM_NOT_SUPPORTED")).toBe("stop");
    expect(afterLaunchFailure("APP_NOT_FOUND")).toBe("next");
    // A launch that may have started the app (agent-desktop: not safe to retry) is looked for, never launched again by another name.
    expect(afterLaunchFailure("ACTION_FAILED", "unsafe")).toBe("look");
    expect(afterLaunchFailure("ACTION_FAILED", "safe")).toBe("next");
    expect(afterLaunchFailure("APP_NOT_FOUND", "safe")).toBe("next");
    expect(afterLaunchFailure("PERM_DENIED", "unsafe")).toBe("stop");
  });

  it("gives an app that is slow to start a few more looks, still under a cap", () => {
    expect(listedTries(false)).toBe(LISTED_TRIES);
    expect(listedTries(true)).toBe(LISTED_TRIES_SLOW);
    expect(LISTED_TRIES_SLOW).toBeGreaterThan(LISTED_TRIES);
    expect(LISTED_TRIES_SLOW).toBeLessThanOrEqual(10);
  });

  it("launches by desktop-entry names first, then the name as said, at most a few", () => {
    expect(linuxLaunchNames({ label: "Chrome", linux: ["google-chrome", "chromium"] })).toEqual(["google-chrome", "chromium", "Chrome", "chrome"]);
    expect(linuxLaunchNames({ label: "Fixture Viewer", linux: [] })).toEqual(["Fixture Viewer", "fixture-viewer"]);
    expect(linuxLaunchNames({ label: "Many", linux: ["a", "b", "c", "d", "e"] })).toHaveLength(4);
    expect(linuxLaunchNames({ label: "-x", linux: ["--arg"] })).toEqual(["x"]);
  });

  it("lists running apps for the AI, short and without repeats", () => {
    expect(runningAppsLine(["google-chrome", "google-chrome", "thunar"])).toBe("list_apps shows: google-chrome, thunar.");
    expect(runningAppsLine([])).toBe("list_apps shows no apps.");
    expect(runningAppsLine(["a", "b", "c"], 2)).toBe("list_apps shows: a, b, ….");
  });
});

// A browser that is listed only from the third list-apps on (it is still starting), and a snapshot that finds it by its listed
// name only once it is.
function coldBrowser(options: { listedFrom?: number; openOk?: boolean } = {}) {
  const calls: Array<{ command: ComputerUseCommand; args: string[] }> = [];
  let lists = 0;
  const listedFrom = options.listedFrom ?? 3;
  const listed = () => lists >= listedFrom;
  const run: ComputerRun = async (command, args) => {
    calls.push({ command, args });
    if (command === "list-apps") {
      lists += 1;
      return { ok: true, data: { apps: listed() ? [{ name: "google-chrome", pid: 7 }, { name: "thunar", pid: 8 }] : [{ name: "thunar", pid: 8 }] } };
    }
    if (command === "snapshot") {
      const app = args.find((arg) => arg.startsWith("--app="))?.slice(6);
      if (!listed() || app !== "google-chrome") return { ok: false, code: "APP_NOT_FOUND" } satisfies AgentDesktopResult;
      return {
        ok: true,
        data: {
          app: "google-chrome",
          snapshot_id: "s9fix",
          complete: true,
          tree: { role: "window", name: "Fixture form", children: [{ role: "textfield", name: "Message", ref_id: "@s9fix:e1" }, { role: "button", name: "Save draft", ref_id: "@s9fix:e2" }, { role: "button", name: "Send", ref_id: "@s9fix:e3" }, { role: "link", name: "Help", ref_id: "@s9fix:e4" }] },
        },
      };
    }
    return { ok: true, data: {} };
  };
  const opened: string[] = [];
  const desktop: DesktopActions = {
    openApp: async (name) => {
      opened.push(name);
      return options.openOk === false ? { ok: false, message: `Could not find ${name}` } : { ok: true, message: `Opened ${name}` };
    },
    focusWindow: async ({ app }) => ({ ok: true, message: `Focused ${app}` }),
    openUrl: async (url) => ({ ok: true, message: `Opened ${url}` }),
  };
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const tools = computerTools({
    run,
    desktop,
    control: createRunControl(),
    platform: "linux",
    askFirst: () => true,
    confirm: async () => true,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  const call = (name: keyof typeof tools, input: unknown) => (tools[name].execute as (input: unknown, options: unknown) => Promise<string>)(input, { toolCallId: `t-${name}`, messages: [] });
  return { call, calls, sleeps, opened, advance: (ms: number) => (clock += ms), lists: () => lists };
}

describe("computer tools: cold vs warm apps", () => {
  beforeEach(() => vi.spyOn(console, "debug").mockImplementation(() => undefined));
  afterEach(() => vi.restoreAllMocks());

  it("waits for an app this run just opened, then reads it by its listed name (cold)", async () => {
    const browser = coldBrowser();
    expect(await browser.call("open_app", { name: "Chrome" })).toBe("Done: Opened Chrome.");
    const read = await browser.call("snapshot", { app: "Chrome" });
    expect(read).toContain("Using google-chrome for Chrome.");
    expect(read).toContain('button "Send" @s9fix:e3');
    // Two misses, a pause between each look, then the match: under the cap.
    expect(browser.lists()).toBe(3);
    expect(browser.sleeps).toHaveLength(2);
  });

  it("looks once and gives the error at once for an app it did not just open (warm path stays fast)", async () => {
    const browser = coldBrowser({ listedFrom: 99 });
    const read = await browser.call("snapshot", { app: "Chrome" });
    expect(read).toMatch(/^Error APP_NOT_FOUND/);
    expect(browser.lists()).toBe(1);
    expect(browser.sleeps).toEqual([]);
  });

  it("stops waiting once the open is no longer recent", async () => {
    const browser = coldBrowser({ listedFrom: 99 });
    await browser.call("open_app", { name: "Chrome" });
    browser.advance(COLD_START_MS + 1);
    await browser.call("snapshot", { app: "Chrome" });
    expect(browser.sleeps).toEqual([]);
  });

  it("after a failed open, uses the exact running name instead of guessing", async () => {
    const browser = coldBrowser({ listedFrom: 1, openOk: false });
    expect(await browser.call("open_app", { name: "Chrome" })).toBe("Done: google-chrome is already running. Use the app name google-chrome; bring it forward with focus_window if needed.");
    // The run now reads it under that name with no second list.
    expect(await browser.call("snapshot", { app: "Chrome" })).toContain('textfield "Message" @s9fix:e1');
  });

  it("after a failed open with no match, lists what runs and never claims the app opened", async () => {
    const browser = coldBrowser({ listedFrom: 99, openOk: false });
    const line = await browser.call("open_app", { name: "Fixture Viewer" });
    expect(line).toBe("Error: Could not find Fixture Viewer. list_apps shows: thunar. If one of these is the app, use that exact name. Never say the app was opened.");
  });
});

// LibreOffice Writer opened cold: list-apps shows it only as soffice, and only from the given look on; its window reads under
// soffice. On a Linux test desktop, Bee said Writer never appeared while it was open (about 85 s).
function coldOffice(listedFrom: number) {
  let lists = 0;
  const reads: string[] = [];
  const run: ComputerRun = async (command, args) => {
    if (command === "list-apps") {
      lists += 1;
      return { ok: true, data: { apps: lists >= listedFrom ? [{ name: "soffice", pid: 7 }, { name: "thunar", pid: 8 }] : [{ name: "thunar", pid: 8 }] } };
    }
    if (command === "snapshot") {
      const app = args.find((arg) => arg.startsWith("--app="))?.slice(6) ?? "";
      reads.push(app);
      if (app !== "soffice" || lists < listedFrom) return { ok: false, code: "APP_NOT_FOUND" } satisfies AgentDesktopResult;
      return { ok: true, data: { app: "soffice", snapshot_id: "s4lo", complete: true, tree: { role: "window", name: "Untitled 1 - LibreOffice Writer", children: [{ role: "textfield", name: "Document", ref_id: "@s4lo:e1" }, { role: "button", name: "Bold", ref_id: "@s4lo:e2" }, { role: "button", name: "Italic", ref_id: "@s4lo:e3" }, { role: "button", name: "Save", ref_id: "@s4lo:e4" }] } } };
    }
    return { ok: true, data: {} };
  };
  let clock = 5_000_000;
  const sleeps: number[] = [];
  const tools = computerTools({
    run,
    desktop: { openApp: async (name) => ({ ok: true, message: `Opened ${name}` }), focusWindow: async ({ app }) => ({ ok: true, message: `Focused ${app}` }), openUrl: async (url) => ({ ok: true, message: url }) },
    control: createRunControl(),
    platform: "linux",
    askFirst: () => true,
    confirm: async () => true,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  const call = (name: keyof typeof tools, input: unknown) => (tools[name].execute as (input: unknown, options: unknown) => Promise<string>)(input, { toolCallId: `t-${name}`, messages: [] });
  return { call, sleeps, reads, lists: () => lists };
}

describe("computer tools: an office app listed under its suite's process", () => {
  beforeEach(() => vi.spyOn(console, "debug").mockImplementation(() => undefined));
  afterEach(() => vi.restoreAllMocks());

  it("waits longer for LibreOffice Writer after opening it, and reads it as soffice", async () => {
    const office = coldOffice(6);
    expect(await office.call("open_app", { name: "LibreOffice Writer" })).toBe("Done: Opened LibreOffice Writer.");
    const read = await office.call("snapshot", { app: "LibreOffice Writer" });
    expect(read).toContain("Using soffice for LibreOffice Writer.");
    expect(read).toContain('textfield "Document" @s4lo:e1');
    // Past the usual four looks, under the slow cap.
    expect(office.lists()).toBe(6);
    expect(office.sleeps).toHaveLength(5);
    expect(office.lists()).toBeLessThanOrEqual(LISTED_TRIES_SLOW);
  });

  it("reads a running Writer through soffice with one look when it did not just open it", async () => {
    const office = coldOffice(1);
    const read = await office.call("snapshot", { app: "LibreOffice Writer" });
    expect(read).toContain("Using soffice for LibreOffice Writer.");
    expect(office.lists()).toBe(1);
    expect(office.sleeps).toEqual([]);
  });
});
