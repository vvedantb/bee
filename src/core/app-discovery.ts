// Finding an app that was just opened, or that runs under another name. A cold app (first open since sign-in) can take seconds
// to show in agent-desktop's list-apps, and on Linux and Windows it is listed by its process or desktop-entry name
// (google-chrome, ms-teams.exe), not the name the user said. Before, a read right after open_app came back APP_NOT_FOUND and the
// AI flailed: retried, focused, clicked, timed out. These helpers keep the warm path as it was (one read) and, only for an app this
// run opened moments ago, look again a few times with a pause, under a cap. Pure: the caller passes list-apps and a sleep.

/** An app opened within this long that is still not listed is starting, not missing. */
export const COLD_START_MS = 30_000;
/** Looks at list-apps for a starting app, at most. */
export const LISTED_TRIES = 4;
/** The pause between those looks. With LISTED_TRIES, at most about 4.5 s of waiting in all. */
export const LISTED_DELAY_MS = 1500;

/** True when the app was opened (openedAt, ms) within COLD_START_MS of now: a miss may only mean it is still starting. */
export function isColdStart(openedAt: number | undefined, now: number, windowMs = COLD_START_MS): boolean {
  return openedAt !== undefined && now >= openedAt && now - openedAt <= windowMs;
}

/** Waits ms, or less when the signal aborts. Never rejects. */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Looks for the app with list until it shows or tries run out: the first look at once, then one each delayMs. list returns the
 * match or null (and null when list-apps itself failed). tries: how many looks ran. Stops early when the signal aborts.
 */
export async function waitForListed<T>(args: {
  list: () => Promise<T | null>;
  tries?: number;
  delayMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): Promise<{ found: T | null; tries: number }> {
  const tries = Math.max(1, args.tries ?? LISTED_TRIES);
  const sleep = args.sleep ?? pause;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    if (args.signal?.aborted) return { found: null, tries: attempt - 1 };
    const found = await args.list();
    if (found !== null) return { found, tries: attempt };
    if (attempt < tries) await sleep(args.delayMs ?? LISTED_DELAY_MS, args.signal);
  }
  return { found: null, tries };
}

/** agent-desktop codes after which trying another launch name is pointless: the app may be starting (look for it instead). */
const STILL_STARTING = new Set(["TIMEOUT", "TIMEOUT_LOCAL", "APP_UNRESPONSIVE"]);
/** Codes that mean no accessibility bus or permission: every other name fails the same way. */
const NO_ACCESS = new Set(["PERM_DENIED", "PLATFORM_NOT_SUPPORTED"]);

/** What to do after a launch name failed: look for the app (it may be starting), stop (no access), or try the next name. */
export function afterLaunchFailure(code: string): "look" | "stop" | "next" {
  if (STILL_STARTING.has(code)) return "look";
  if (NO_ACCESS.has(code)) return "stop";
  return "next";
}

/** At most this many names per launch: each one that is not installed costs a call. */
export const LAUNCH_NAMES_MAX = 4;

/**
 * The names to launch an app by on Linux, best first: its desktop-entry names (google-chrome, then chromium), then the name as
 * said, then that name in desktop-entry form ("Google Chrome" → google-chrome). No repeats, at most LAUNCH_NAMES_MAX.
 */
export function linuxLaunchNames(app: { label: string; linux?: readonly string[] | null }): string[] {
  const entry = app.label
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  const names = [...(app.linux ?? []), app.label, entry].map((name) => name.trim()).filter((name) => name.length > 0 && !name.startsWith("-"));
  const seen = new Set<string>();
  return names.filter((name) => (seen.has(name) ? false : (seen.add(name), true))).slice(0, LAUNCH_NAMES_MAX);
}

/** Names of running apps for an error the AI reads, so it can retry with an exact listed name. At most max, no repeats. */
export function runningAppsLine(names: readonly string[], max = 20): string {
  const unique = [...new Set(names.map((name) => name.replace(/\s+/g, " ").trim()).filter(Boolean))];
  if (unique.length === 0) return "list_apps shows no apps.";
  const shown = unique.slice(0, max).join(", ");
  return `list_apps shows: ${shown}${unique.length > max ? ", …" : ""}.`;
}
