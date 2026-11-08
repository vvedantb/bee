import { describe, expect, it } from "vitest";
import { COLD_START_MS, LISTED_TRIES, LISTED_TRIES_SLOW, afterLaunchFailure, isColdStart, linuxLaunchNames, listedTries, runningAppsLine, waitForListed } from "./app-discovery";

// Cold vs warm app discovery: the pure helpers, used by main/desktop-actions.ts for a Linux launch.

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
