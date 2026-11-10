import { appKind, echoesOwnLine, type MeetingApp } from "./agent-desktop-meeting";
import type { SessionLine } from "./session-lines";
import {
  MEET_BROWSERS,
  TEAMS_MAC_BUNDLE_IDS,
  TEAMS_WINDOWS_IMAGES,
  ZOOM_MAC_BUNDLE_IDS,
  ZOOM_WINDOWS_IMAGES,
  isCallAudioBundleId,
} from "./teams-audio-protocol";

// Call audio (internally still "Teams audio"), pure parts: whether this build can hear one app on its own, which app to hear
// for the call Bee detected (Teams, Zoom, or the browser running Google Meet), when to listen, and which lines repeat speech
// Bee already has. Bee hears the call app alone or nothing: never all system audio, never a music or video app.

export type TeamsAudioPlatform = "windows" | "mac" | "linux" | "other";
/**
 * Why Bee cannot hear the call app here. unsupported-platform: Linux and others (no fallback). needs-app-audio: this build has
 * no per-app capture path for the platform. os-too-old: below the helper's OS floor. helper-missing: the native helper is not
 * in this install (a development checkout that has not built it, or a damaged install).
 */
export type TeamsAudioReason = "unsupported-platform" | "needs-app-audio" | "os-too-old" | "helper-missing";
export type TeamsAudioSupport = { supported: boolean; reason: TeamsAudioReason | null };

// Platforms with a per-app capture path in this build: Windows (WASAPI process loopback on the call app's process tree) and
// macOS (ScreenCaptureKit filtered to the call app), both through the in-repo helper in native/teams-audio. Electron's own
// display media audio is the whole system, so Bee never uses it. A platform here still reports unsupported at run time when
// its helper is missing or the OS is too old. See ARCHITECTURE.md.
export const TEAMS_APP_AUDIO: Readonly<Record<"windows" | "mac", boolean>> = { windows: true, mac: true };

/**
 * OS floors for the helpers. Windows: build 19041 (Windows 10 version 2004). Microsoft documents process loopback from build
 * 20348; it is used from 19041 elsewhere (GStreamer), so Bee tries from there and reports "unsupported" if Windows refuses.
 * macOS: ScreenCaptureKit audio needs macOS 13 (Darwin 22).
 */
export const TEAMS_AUDIO_MIN_WINDOWS_BUILD = 19_041;
export const TEAMS_AUDIO_MIN_DARWIN = 22;

export function teamsAudioPlatform(platform: string): TeamsAudioPlatform {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "mac";
  return platform === "linux" ? "linux" : "other";
}

/** Whether the OS is at or above the helper's floor, from os.release(): "10.0.22631" on Windows, the Darwin version on macOS. */
export function teamsAudioOsSupported(platform: TeamsAudioPlatform, release: string): boolean {
  const parts = release.split(".").map((part) => Number.parseInt(part, 10));
  if (platform === "windows") {
    const [major = 0, , build = 0] = parts;
    return major > 10 || (major === 10 && build >= TEAMS_AUDIO_MIN_WINDOWS_BUILD);
  }
  if (platform === "mac") return (parts[0] ?? 0) >= TEAMS_AUDIO_MIN_DARWIN;
  return false;
}

/** What main knows about this machine before any capture: the OS floor, and whether the helper binary is installed. */
export type TeamsAudioHost = { osSupported: boolean; helperFound: boolean };

/**
 * Whether Bee can hear one app alone here. Linux has no fallback; Windows and macOS need a per-app capture path in this
 * build, an OS at the helper's floor and the helper itself. Without host, only the build is checked.
 */
export function teamsAudioSupport(
  platform: TeamsAudioPlatform,
  appAudio: Readonly<Record<"windows" | "mac", boolean>> = TEAMS_APP_AUDIO,
  host?: TeamsAudioHost,
): TeamsAudioSupport {
  if (platform !== "windows" && platform !== "mac") return { supported: false, reason: "unsupported-platform" };
  if (!appAudio[platform]) return { supported: false, reason: "needs-app-audio" };
  if (host && !host.osSupported) return { supported: false, reason: "os-too-old" };
  if (host && !host.helperFound) return { supported: false, reason: "helper-missing" };
  return { supported: true, reason: null };
}

// ---- When to listen ----

/**
 * off: setting off. unavailable: no per-app capture here. waiting: no call Bee can hear, or the mic is off. listen: hear the
 * call app. Client sync is gone, so no one is ever "covered" by a teammate's Bee: a call with the mic on always listens.
 */
export type TeamsAudioPlan = "off" | "unavailable" | "waiting" | "listen";

export function teamsAudioPlan(args: { enabled: boolean; supported: boolean; inCall: boolean; micOn: boolean }): TeamsAudioPlan {
  if (!args.enabled) return "off";
  if (!args.supported) return "unavailable";
  if (!args.inCall || !args.micOn) return "waiting";
  return "listen";
}

// ---- Which app to hear ----

/**
 * The app the helper hears. processes: Windows image names (the helper includes each one's process tree). bundleIds: macOS
 * bundle ids (and their `<id>.…` helper apps). pid: the call window's process, if known (Windows: the helper climbs to the top
 * of that app's tree). Names stay in main; the renderer only sees kind.
 */
export type CallAudioTarget = { kind: MeetingApp; processes: string[]; bundleIds: string[]; pid: number | null };

/** What main knows about the call window the meeting window reader found. Names never leave main. */
export type CallWindow = { app: MeetingApp; appName: string; pid: number | null; bundleId: string | null };

const TEAMS_TARGET: CallAudioTarget = { kind: "teams", processes: [...TEAMS_WINDOWS_IMAGES], bundleIds: [...TEAMS_MAC_BUNDLE_IDS], pid: null };
const ZOOM_TARGET: CallAudioTarget = { kind: "zoom", processes: [...ZOOM_WINDOWS_IMAGES], bundleIds: [...ZOOM_MAC_BUNDLE_IDS], pid: null };

/** The browser that owns a Meet window: by bundle id first (exact or a channel such as "com.google.chrome.beta"), then by name. */
function meetBrowser(window: CallWindow): (typeof MEET_BROWSERS)[number] | null {
  const bundle = (window.bundleId ?? "").toLowerCase();
  const byBundle = bundle ? MEET_BROWSERS.find((browser) => isCallAudioBundleId(bundle, [browser.bundleId])) : undefined;
  if (byBundle) return byBundle;
  // A bundle id that is some other browser (Safari, an unknown one) is never guessed from the name.
  if (bundle && appKind("", bundle) === "browser") return null;
  const name = window.appName.trim().toLowerCase().replace(/\.exe$/, "");
  return MEET_BROWSERS.find((browser) => browser.names.test(name)) ?? null;
}

/**
 * The app to hear for the call Bee sees. The meeting window reader's call wins (it names the app); else the built-in Windows
 * detector's Teams call. A Meet call is heard through its browser only when Bee knows that browser (not Safari). Null: no call,
 * or a call Bee cannot hear on its own.
 */
export function callAudioTarget(args: { window: CallWindow | null; teamsDetector: boolean }): CallAudioTarget | null {
  const window = args.window;
  if (window?.app === "teams") return { ...TEAMS_TARGET };
  if (window?.app === "zoom") return { ...ZOOM_TARGET };
  if (window?.app === "meet") {
    const browser = meetBrowser(window);
    if (browser) return { kind: "meet", processes: [browser.image], bundleIds: [browser.bundleId], pid: window.pid };
  }
  return args.teamsDetector ? { ...TEAMS_TARGET } : null;
}

/** Two targets are the same capture: same app, same process. A different one restarts the helper. */
export function sameCallAudioTarget(a: CallAudioTarget | null, b: CallAudioTarget | null): boolean {
  if (!a || !b) return a === b;
  return a.kind === b.kind && a.pid === b.pid && a.processes.join() === b.processes.join() && a.bundleIds.join() === b.bundleIds.join();
}

/**
 * The helper's arguments for a target (native/teams-audio/README.md). Windows: --image for each process name, and --pid for the
 * call window's process. macOS: --bundle-id for each bundle id. The helper refuses anything outside its own allowlist.
 */
export function callAudioHelperArgs(target: CallAudioTarget, platform: TeamsAudioPlatform): string[] {
  if (platform === "windows") return [...target.processes.flatMap((image) => ["--image", image]), ...(target.pid !== null ? ["--pid", String(target.pid)] : [])];
  if (platform === "mac") return target.bundleIds.flatMap((id) => ["--bundle-id", id]);
  return [];
}

// ---- Dedupe ----

/** Session lines heard through call audio carry this speaker id, and this name: the speaker is not known, only that it is not the user. */
export const TEAMS_AUDIO_SPEAKER_ID = "teams-audio";
export const TEAMS_AUDIO_SPEAKER = "Meeting";
/** Lines this close in time with the same words (echoesOwnLine: 0.6 word Dice) are the same speech twice. */
export const TEAMS_AUDIO_ECHO_MS = 20_000;
/**
 * Mic echo: without headphones the mic hears the far end through the speakers. A mic line and a call-audio line with the same
 * words (0.6 word Dice) this close in time are the far end twice; the call-audio copy is kept, as it is not the user.
 */
export const CALL_AUDIO_MIC_ECHO_MS = 10_000;

export const isTeamsAudioLine = (line: Pick<SessionLine, "speakerId">): boolean => line.speakerId === TEAMS_AUDIO_SPEAKER_ID;

/**
 * A call-audio phrase that repeats a live caption from the last 20 s. The caption names the speaker, so the call-audio copy is
 * dropped. The user's own lines are not checked here: a mic line with the same words is an echo of the call, and
 * teamsAudioReplaced swaps it for the call-audio line.
 */
export function teamsAudioEcho(text: string, lines: readonly SessionLine[], now: number): boolean {
  const recent = lines.filter((line) => !line.own && !isTeamsAudioLine(line) && Math.abs(now - line.clientTs) < TEAMS_AUDIO_ECHO_MS).map((line) => line.text);
  return echoesOwnLine(text, recent);
}

/** A mic phrase that repeats a call-audio line from the last 10 s: the mic heard the call through the speakers. Dropped. */
export function micEchoesCallAudio(text: string, lines: readonly SessionLine[], now: number): boolean {
  const recent = lines.filter((line) => isTeamsAudioLine(line) && Math.abs(now - line.clientTs) < CALL_AUDIO_MIC_ECHO_MS).map((line) => line.text);
  return echoesOwnLine(text, recent);
}

/**
 * Lines that an incoming line replaces. by: the incoming line's id; its words are already in, so it starts no turn.
 * - A call-audio line repeated by a later caption: the caption names the speaker.
 * - The user's own mic line repeated by a later call-audio line within 10 s: the mic heard the far end through the speakers,
 *   so the line was not the user's.
 */
export function teamsAudioReplaced(lines: readonly SessionLine[], incoming: readonly SessionLine[]): Array<{ id: string; by: string }> {
  const replaced: Array<{ id: string; by: string }> = [];
  for (const line of lines) {
    let by: SessionLine | undefined;
    if (isTeamsAudioLine(line)) {
      by = incoming.find((next) => !next.own && !isTeamsAudioLine(next) && Math.abs(next.clientTs - line.clientTs) < TEAMS_AUDIO_ECHO_MS && echoesOwnLine(line.text, [next.text]));
    } else if (line.own) {
      by = incoming.find((next) => isTeamsAudioLine(next) && Math.abs(next.clientTs - line.clientTs) < CALL_AUDIO_MIC_ECHO_MS && echoesOwnLine(line.text, [next.text]));
    }
    if (by) replaced.push({ id: line.id, by: by.id });
  }
  return replaced;
}
