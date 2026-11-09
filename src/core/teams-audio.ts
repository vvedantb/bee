import { echoesOwnLine } from "./agent-desktop-meeting";
import type { SessionLine } from "./session-lines";

// Teams audio fallback, pure parts: whether this build can hear the Teams app on its own, when to listen, and which Teams-audio lines repeat speech Bee already has. Bee hears the
// Teams app alone or nothing: a platform without a Teams-only capture path never falls back to all system audio.

export type TeamsAudioPlatform = "windows" | "mac" | "linux" | "other";
/**
 * Why Bee cannot hear Teams here. unsupported-platform: Linux and others (no fallback). needs-app-audio: this build has no
 * Teams-only capture path for the platform. os-too-old: below the helper's OS floor. helper-missing: the native helper is not
 * in this install (a development checkout that has not built it, or a damaged install).
 */
export type TeamsAudioReason = "unsupported-platform" | "needs-app-audio" | "os-too-old" | "helper-missing";
export type TeamsAudioSupport = { supported: boolean; reason: TeamsAudioReason | null };

// Platforms with a Teams-only (per-app) capture path in this build: Windows (WASAPI process loopback on the Teams process tree)
// and macOS (ScreenCaptureKit filtered to the Teams app), both through the in-repo helper in native/teams-audio. Electron's own
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
 * Whether Bee can hear the Teams app alone here. Linux has no fallback; Windows and macOS need a per-app capture path in this
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
 * off: setting off. unavailable: no Teams-only capture here. waiting: no Teams call, or the mic is off. listen: hear the Teams app.
 * Client sync is gone, so no one is ever "covered" by a teammate's Bee: a Teams call with the mic on always listens.
 */
export type TeamsAudioPlan = "off" | "unavailable" | "waiting" | "listen";

export function teamsAudioPlan(args: { enabled: boolean; supported: boolean; teamsCall: boolean; micOn: boolean }): TeamsAudioPlan {
  if (!args.enabled) return "off";
  if (!args.supported) return "unavailable";
  if (!args.teamsCall || !args.micOn) return "waiting";
  return "listen";
}

// ---- Dedupe ----

/** Session lines heard through Teams audio carry this speaker id, and this name: the speaker is not known. */
export const TEAMS_AUDIO_SPEAKER_ID = "teams-audio";
export const TEAMS_AUDIO_SPEAKER = "Meeting";
/** Lines this close in time with the same words (echoesOwnLine: 0.6 word Dice) are the same speech twice. */
export const TEAMS_AUDIO_ECHO_MS = 20_000;

export const isTeamsAudioLine = (line: Pick<SessionLine, "speakerId">): boolean => line.speakerId === TEAMS_AUDIO_SPEAKER_ID;

/**
 * A Teams-audio phrase that repeats a line Bee already has from the last 20 s: the user's own (a mic in the same room picked
 * them up), or a live caption. Those name the speaker, so the Teams-audio copy is dropped.
 */
export function teamsAudioEcho(text: string, lines: readonly SessionLine[], now: number): boolean {
  const recent = lines.filter((line) => !isTeamsAudioLine(line) && Math.abs(now - line.clientTs) < TEAMS_AUDIO_ECHO_MS).map((line) => line.text);
  return echoesOwnLine(text, recent);
}

/**
 * Teams-audio lines that an incoming caption line repeats (it arrived later, from the caption poll).
 * The incoming line names the speaker, so it replaces them. by: the incoming line's id.
 */
export function teamsAudioReplaced(lines: readonly SessionLine[], incoming: readonly SessionLine[]): Array<{ id: string; by: string }> {
  const heard = lines.filter(isTeamsAudioLine);
  if (heard.length === 0) return [];
  const replaced: Array<{ id: string; by: string }> = [];
  for (const line of heard) {
    const by = incoming.find((next) => !next.own && !isTeamsAudioLine(next) && Math.abs(next.clientTs - line.clientTs) < TEAMS_AUDIO_ECHO_MS && echoesOwnLine(line.text, [next.text]));
    if (by) replaced.push({ id: line.id, by: by.id });
  }
  return replaced;
}
