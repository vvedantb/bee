import { parseSnapshotTree, type AdNode, type AgentDesktopResult } from "./agent-desktop-envelope";
import { CONTROL_ROLE, detectMeetings, textOf, walk } from "./agent-desktop-meeting";
import { debugLog, errorData, msSince } from "./debug-log";
import { frontOf, lookTarget, readFocusedWindows, type CaptureOptions, type FrontWindow, type ScreenCapture } from "./screen-look";

// The user's screen as context for meeting tips (Luna, core/luna.ts screenBlock), while a meeting is active only. Text first:
// the front window's accessibility text, read with the same list-windows and snapshot commands as look_at_screen and computer
// use. A small picture only when the window shows next to no text, or it is the call window (a shared slide is video), at most
// one every SCREEN_PICTURE_GAP_MS and only when it changed. Bee itself, terminals, password managers and system settings are
// never read (screen-look.ts frontOf, computer-tools.ts offLimitsApp). Nothing here logs or stores the text or the picture:
// lengths, yes or no and ms only. Pure or injected, so tests need no Electron or agent-desktop.

/** The window's text Luna gets, at most, in characters. */
export const SCREEN_TEXT_MAX = 1500;
/** Fewer content characters than this (control labels not counted) is a window with no readable text: a picture may help. */
export const SCREEN_THIN_CHARS = 80;
/** How long a tip run waits for the window's text; past it the run goes on without (or with a recent read). */
export const SCREEN_TEXT_MS = 400;
/** How long a tip run waits for the screen in all, picture included. pipeline.ts holds Luna no longer than this. */
export const SCREEN_PICTURE_MS = 800;
/** A text read this recent is used as it is: a burst of lines does not read the window again. */
export const SCREEN_TEXT_FRESH_MS = 5000;
/** A read this recent stands in when a new one is slow. Older is dropped: the user may have moved on. */
export const SCREEN_TEXT_STALE_MS = 15_000;
/** At most one new picture in this long. */
export const SCREEN_PICTURE_GAP_MS = 20_000;
/** The tip picture: smaller than look_at_screen's, to keep image tokens down, and never a macOS prompt during a call. */
export const SCREEN_CAPTURE: CaptureOptions = { maxSide: 1024, quality: 70, ask: false };
/** The side of the grey thumbnail averageHash reads (8 x 8 = 64 bits). */
export const HASH_SIDE = 8;
/** Pictures whose hashes differ in more bits than this count as changed. */
export const HASH_CHANGE_BITS = 5;

// agent-desktop's budget for the window's tree, and the process timeout around it. The read goes on past SCREEN_TEXT_MS and
// fills the cache for the next line.
const SNAPSHOT_MS = 1500;
const KILL_MARGIN_MS = 1000;
// Fields that hold a secret: never read, whatever they show.
const SECRET_ROLE = /secure|password/i;
const TITLE_MAX = 200;

/** Any agent-desktop runner that may list windows and read a snapshot (main/index.ts gives meeting tips a read-only one). */
export type ScreenRun = (command: "list-windows" | "snapshot", args: string[], options?: { timeoutMs?: number }) => Promise<AgentDesktopResult>;
export type ScreenPicture = { data: string; mediaType: "image/jpeg" };
/** What a tip run gets: the front window's app and title, its text (capped, maybe empty) and a picture when one is due. */
export type ScreenGlance = { app: string; title: string; text: string; picture: ScreenPicture | null };

/** Whitespace collapsed to single spaces. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Text cut to `max` characters at most, on a word when it can, with "…" when cut. */
export function capText(text: string, max = SCREEN_TEXT_MAX): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.8 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * A window's text from its accessibility tree: content first (text, headings, cells), then control labels (buttons, tabs,
 * links), each piece once, one per line, capped at `max`. The title and secret fields are left out. contentChars counts the
 * content alone, for isThin.
 */
export function screenText(tree: AdNode | null, title = "", max = SCREEN_TEXT_MAX): { text: string; contentChars: number } {
  if (!tree) return { text: "", contentChars: 0 };
  const seen = new Set([oneLine(title)]);
  const content: string[] = [];
  const controls: string[] = [];
  for (const node of walk(tree)) {
    if (SECRET_ROLE.test(node.role)) continue;
    const text = textOf(node);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    (CONTROL_ROLE.test(node.role) ? controls : content).push(text);
  }
  const contentChars = content.join("\n").length;
  return { text: capText([...content, ...controls].join("\n"), max), contentChars };
}

/** No readable text: a canvas, an image, a video, or an app that exposes next to nothing. */
export const isThin = (contentChars: number): boolean => contentChars < SCREEN_THIN_CHARS;

/** The call window itself (Teams, Zoom or Google Meet, as the meeting window reader tells them): a shared slide in it is video. */
export function isCallWindow(window: { id: string; app: string; title: string; pid: number | null; focused: boolean }): boolean {
  return detectMeetings({ windows: [window] }).length > 0;
}

/** A picture may be taken now: none yet, or the last was at least `gap` ago. */
export function pictureDue(lastAt: number | null, now: number, gap = SCREEN_PICTURE_GAP_MS): boolean {
  return lastAt === null || now - lastAt >= gap;
}

/**
 * A 64-bit average hash of an 8 x 8 bitmap (4 bytes a pixel, as Electron's toBitmap gives it; the channel order does not
 * matter), as 16 hex digits. Each bit: the pixel is brighter than the mean. A small change (a cursor, a clock) moves few bits.
 */
export function averageHash(bitmap: Uint8Array): string {
  const pixels = Math.min(HASH_SIDE * HASH_SIDE, Math.floor(bitmap.length / 4));
  const grey: number[] = [];
  for (let index = 0; index < pixels; index += 1) grey.push((bitmap[index * 4] ?? 0) + (bitmap[index * 4 + 1] ?? 0) + (bitmap[index * 4 + 2] ?? 0));
  const mean = grey.reduce((sum, value) => sum + value, 0) / Math.max(1, grey.length);
  let hex = "";
  for (let start = 0; start < HASH_SIDE * HASH_SIDE; start += 4) {
    let nibble = 0;
    for (let bit = 0; bit < 4; bit += 1) nibble = (nibble << 1) | ((grey[start + bit] ?? 0) > mean ? 1 : 0);
    hex += nibble.toString(16);
  }
  return hex;
}

/** How many bits two hashes differ in. Hashes of different lengths differ in every bit. */
export function hashDistance(a: string, b: string): number {
  if (a.length !== b.length) return Math.max(a.length, b.length) * 4;
  let bits = 0;
  for (let index = 0; index < a.length; index += 1) {
    let xor = parseInt(a[index] ?? "0", 16) ^ parseInt(b[index] ?? "0", 16);
    while (xor) {
      bits += xor & 1;
      xor >>= 1;
    }
  }
  return bits;
}

/** The picture is new: no picture was sent yet, or it differs from the last one sent by more than HASH_CHANGE_BITS. */
export function pictureChanged(last: string | null, next: string): boolean {
  return last === null || hashDistance(last, next) > HASH_CHANGE_BITS;
}

/** The work's result, or null when it fails or takes longer than `ms`. The work itself is not stopped. */
export function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), Math.max(0, ms));
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/** One read of the front window. null: no window Bee may read (none, Bee itself, an off-limits app). */
type Reading = { front: FrontWindow; app: string; title: string; text: string; thin: boolean; call: boolean } | null;

/**
 * The screen reader for meeting tips. read() gives the front window's text within SCREEN_TEXT_MS (a fresh cached read, else a
 * new one, else a recent one), and a picture within SCREEN_PICTURE_MS when it is due. run: agent-desktop (null: no text, so no
 * picture either, as Bee cannot tell which window it would be). look: main's capture (null or "other": text only).
 */
export function createScreenReader(deps: { run: ScreenRun | null; look: ScreenCapture | null; now?: () => number }) {
  const now = deps.now ?? Date.now;
  let cache: { at: number; reading: Reading } | null = null;
  let reading: Promise<Reading> | null = null;
  let lastPictureAt: number | null = null;
  let lastHash: string | null = null;

  const readFront = async (run: ScreenRun): Promise<Reading> => {
    const started = performance.now();
    const focused = await readFocusedWindows(run);
    const window = frontOf(focused);
    const target = lookTarget(focused);
    if (!window || !target.ok) {
      debugLog.info("screen", "tips-read", { window: false, ms: msSince(started) });
      return null;
    }
    const snap = await run("snapshot", [`--app=${window.app}`, `--window-id=${window.id}`, "--compact", `--timeout-ms=${SNAPSHOT_MS}`], { timeoutMs: SNAPSHOT_MS + KILL_MARGIN_MS });
    const { text, contentChars } = screenText(snap.ok ? parseSnapshotTree(snap.data) : null, window.title);
    const call = isCallWindow(window);
    debugLog.info("screen", "tips-read", { window: true, snapshot: snap.ok, chars: text.length, contentChars, call, ms: msSince(started) });
    return { front: target.front, app: window.app, title: oneLine(window.title).slice(0, TITLE_MAX), text, thin: isThin(contentChars), call };
  };

  /** A new read, shared by every run that asks while it is in flight. Its result is cached when it lands, late or not. */
  const refresh = (run: ScreenRun): Promise<Reading> => {
    reading ??= readFront(run)
      .catch((error: unknown): Reading => {
        debugLog.info("screen", "tips-read-failed", { error: errorData(error) });
        return null;
      })
      .then((result) => {
        cache = { at: now(), reading: result };
        reading = null;
        return result;
      });
    return reading;
  };

  return {
    async read(): Promise<ScreenGlance | null> {
      const run = deps.run;
      if (!run) return null;
      const started = now();
      const age = cache ? started - cache.at : Infinity;
      let source: "fresh" | "read" | "stale" | "none" = "fresh";
      let current: Reading = cache && age <= SCREEN_TEXT_FRESH_MS ? cache.reading : null;
      if (!cache || age > SCREEN_TEXT_FRESH_MS) {
        const read = await withDeadline(refresh(run), SCREEN_TEXT_MS);
        // A read that missed the deadline, or failed: a recent one stands in.
        const latest = cache && now() - cache.at <= SCREEN_TEXT_STALE_MS ? cache : null;
        if (read) {
          current = read;
          source = "read";
        } else {
          current = latest?.reading ?? null;
          source = current ? "stale" : "none";
        }
      }
      if (!current) {
        debugLog.info("screen", "tips-glance", { source, chars: 0, picture: false, ms: now() - started });
        return null;
      }
      let picture: ScreenPicture | null = null;
      let changed: boolean | null = null;
      const look = deps.look;
      if (look && look.platform !== "other" && (current.thin || current.call) && pictureDue(lastPictureAt, now())) {
        lastPictureAt = now();
        const outcome = await withDeadline(look.capture(current.front, SCREEN_CAPTURE), SCREEN_PICTURE_MS - (now() - started));
        if (outcome?.ok) {
          changed = pictureChanged(lastHash, outcome.shot.hash);
          if (changed) {
            lastHash = outcome.shot.hash;
            picture = { data: outcome.shot.data, mediaType: outcome.shot.mediaType };
          }
        }
        debugLog.info("screen", "tips-picture", { outcome: outcome ? (outcome.ok ? "ok" : outcome.reason) : "timeout", changed, bytes: picture ? Math.round((picture.data.length * 3) / 4) : 0 });
      }
      debugLog.info("screen", "tips-glance", { source, chars: current.text.length, thin: current.thin, call: current.call, picture: picture !== null, ms: now() - started });
      if (!current.text && !picture) return null;
      return { app: current.app, title: current.title, text: current.text, picture };
    },
  };
}
