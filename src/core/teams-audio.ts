import { echoesOwnLine } from "./agent-desktop-meeting";
import type { SessionLine } from "./session-lines";

// Call audio (internally still "Teams audio"), pure parts: whether this build can hear the computer's sound here, when to
// listen, and which lines repeat speech Bee already has. Bee hears everything the computer plays (all system audio, as Cluely
// does) while its mic is on, through the native helper (native/teams-audio): never the screen, and never Bee's own sound.

export type TeamsAudioPlatform = "windows" | "mac" | "linux" | "other";
/**
 * Why Bee cannot hear the computer's sound here. unsupported-platform: Linux and others (no fallback). needs-app-audio: this
 * build has no capture path for the platform. os-too-old: below the helper's OS floor. helper-missing: the native helper is not
 * in this install (a development checkout that has not built it, or a damaged install).
 */
export type TeamsAudioReason = "unsupported-platform" | "needs-app-audio" | "os-too-old" | "helper-missing";
export type TeamsAudioSupport = { supported: boolean; reason: TeamsAudioReason | null };

// Platforms with a capture path in this build: Windows (WASAPI loopback on the default playback device) and macOS
// (ScreenCaptureKit, every app but Bee), both through the in-repo helper in native/teams-audio. A platform here still reports
// unsupported at run time when its helper is missing or the OS is too old. See ARCHITECTURE.md.
export const TEAMS_APP_AUDIO: Readonly<Record<"windows" | "mac", boolean>> = { windows: true, mac: true };

/** OS floors for the helpers. Windows 10 (build 10240): loopback capture is older still. macOS: ScreenCaptureKit audio needs macOS 13 (Darwin 22). */
export const TEAMS_AUDIO_MIN_WINDOWS_BUILD = 10_240;
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
 * Whether Bee can hear the computer's sound here. Linux has no fallback; Windows and macOS need a capture path in this build,
 * an OS at the helper's floor and the helper itself. Without host, only the build is checked.
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
 * off: setting off. unavailable: no capture here. waiting: the mic is off (Bee is not listening). listen: hear the computer's
 * sound. Bee hears it whenever its mic is on: no call app needs to be found first.
 */
export type TeamsAudioPlan = "off" | "unavailable" | "waiting" | "listen";

export function teamsAudioPlan(args: { enabled: boolean; supported: boolean; micOn: boolean }): TeamsAudioPlan {
  if (!args.enabled) return "off";
  if (!args.supported) return "unavailable";
  if (!args.micOn) return "waiting";
  return "listen";
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
