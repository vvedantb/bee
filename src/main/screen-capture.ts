import { BrowserWindow, desktopCapturer, nativeImage, screen, systemPreferences, type NativeImage } from "electron";
import type { AccessState } from "../core/agent-desktop-envelope";
import type { ShotImage } from "../core/computer-vision";
import { debugLog, errorData } from "../core/debug-log";
import { HASH_SIDE, averageHash } from "../core/screen-context";
import { LOOK_CAPTURE, lookSize, pickScreenSource, pickWindowSource, type CaptureOptions, type CaptureOutcome, type FrontWindow, type ScreenCapture } from "../core/screen-look";

// look_at_screen's picture (core/screen-look.ts), and the small one meeting tips may add (core/screen-context.ts): the front
// window through Electron's desktopCapturer, or the display it is on when the window has no source of its own. Kept in memory
// only: never written to disk and never logged. On macOS it needs Screen Recording; the first time it is missing, asking for
// sources makes macOS show its own prompt (look_at_screen only: meeting tips never ask). Windows needs no permission. Linux has none.

/** The picture as JPEG base64, scaled so its long side is at most options.maxSide, with its hash. Failed when the capture came back empty. */
function encode(image: NativeImage, source: "window" | "screen", options: CaptureOptions = LOOK_CAPTURE): CaptureOutcome {
  if (image.isEmpty()) return { ok: false, reason: "failed" };
  const now = image.getSize();
  const size = lookSize(now.width, now.height, options.maxSide);
  const scaled = size.width === now.width && size.height === now.height ? image : image.resize({ ...size, quality: "good" });
  const hash = averageHash(scaled.resize({ width: HASH_SIDE, height: HASH_SIDE, quality: "good" }).toBitmap());
  return { ok: true, shot: { data: scaled.toJPEG(options.quality).toString("base64"), mediaType: "image/jpeg", ...size, source, hash } };
}

/**
 * computer use's look (core/computer-tools.ts): agent-desktop's PNG of one window as JPEG, its long side at most LOOK_MAX_SIDE, so
 * the picture the AI reads is the one its points are in. In memory only. Null when the PNG cannot be read.
 */
export function shrinkShot(png: string): ShotImage | null {
  try {
    const image = nativeImage.createFromBuffer(Buffer.from(png, "base64"));
    const encoded = encode(image, "window");
    return encoded.ok ? { data: encoded.shot.data, mediaType: encoded.shot.mediaType, width: encoded.shot.width, height: encoded.shot.height } : null;
  } catch (error) {
    debugLog.warn("screen", "shrink-failed", { error: errorData(error) });
    return null;
  }
}

/** The display the window is on (by its bounds), else the one under the pointer. */
function displayFor(front: FrontWindow): number {
  if (front.bounds) return screen.getDisplayMatching(front.bounds).id;
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id;
}

/** The display with Bee's own windows hidden from the picture (content protection), each set back after. */
async function withoutBee<T>(take: () => Promise<T>): Promise<T> {
  const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed() && !window.isContentProtected());
  for (const window of windows) window.setContentProtection(true);
  try {
    return await take();
  } finally {
    for (const window of windows) if (!window.isDestroyed()) window.setContentProtection(false);
  }
}

/** macOS Screen Recording for Bee itself, for look_at_screen and Settings. Not-determined or unknown reads as unknown. */
export function macScreenRecording(): AccessState {
  const status = systemPreferences.getMediaAccessStatus("screen");
  return status === "granted" ? "granted" : status === "denied" || status === "restricted" ? "denied" : "unknown";
}

export function createScreenCapture(platform: NodeJS.Platform): ScreenCapture {
  if (platform !== "darwin" && platform !== "win32") return { platform: "other", capture: async () => ({ ok: false, reason: "failed" }) };
  // macOS shows its Screen Recording prompt once per app; Bee asks at most once per run.
  let asked = false;
  return {
    platform: platform === "darwin" ? "mac" : "windows",
    capture: async (front, options = LOOK_CAPTURE) => {
      if (platform === "darwin" && macScreenRecording() !== "granted") {
        if (options.ask && !asked) {
          asked = true;
          await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } }).catch(() => []);
        }
        return { ok: false, reason: "permission" };
      }
      try {
        const thumbnailSize = { width: options.maxSide, height: options.maxSide };
        const windows = await desktopCapturer.getSources({ types: ["window"], thumbnailSize, fetchWindowIcons: false });
        const window = pickWindowSource(windows, front);
        const fromWindow = window ? encode(window.thumbnail, "window", options) : null;
        if (fromWindow?.ok) return fromWindow;
        debugLog.info("screen", "look-window-missing", { matched: window !== null, screen: front.screen });
        if (!front.screen) return { ok: false, reason: "failed" };
        const displayId = displayFor(front);
        return await withoutBee(async (): Promise<CaptureOutcome> => {
          const screens = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize });
          const found = pickScreenSource(screens, displayId);
          return found ? encode(found.thumbnail, "screen", options) : { ok: false, reason: "failed" };
        });
      } catch (error) {
        debugLog.warn("screen", "look-capture-failed", { error: errorData(error) });
        return { ok: false, reason: "failed" };
      }
    },
  };
}
