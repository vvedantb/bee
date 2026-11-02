import { PARTICIPANTS_MAX, echoesOwnLine } from "./agent-desktop-meeting";
import type { SessionLine } from "./sync-lines";

// Teams audio fallback, pure parts: whether this build can hear the Teams app on its own, whether the people in the call
// already have Bee in this sync, when to listen, and which Teams-audio lines repeat speech Bee already has. Bee hears the
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

// ---- Coverage: does everyone in the call have Bee in this sync? ----

export type TeamsAudioCoverage = "covered" | "uncovered" | "unknown";

/** Lowercase words without accents or punctuation ("José O'Neil" → "jose", "o", "neil"). */
function nameWords(name: string): string[] {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((word) => word.length > 0);
}

const wordsMatch = (a: string, b: string): boolean => a === b || (a.length === 1 && b.startsWith(a)) || (b.length === 1 && a.startsWith(b));

/**
 * A roster name and a Bee display name are the same person: every word of the shorter name matches its own word of the
 * longer one, in any order, and at least one matches whole. An initial matches a word it starts. "Alice" matches
 * "Alice Smith"; "A. Smith" matches "Alice Smith"; "Al" does not match "Alice".
 */
export function namesMatch(a: string, b: string): boolean {
  const left = nameWords(a);
  const right = nameWords(b);
  if (left.length === 0 || right.length === 0) return false;
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  const free = [...long];
  let whole = false;
  for (const word of short) {
    // A whole-word match first, so an initial does not take a word another word needs.
    let at = free.indexOf(word);
    if (at >= 0) whole = true;
    else at = free.findIndex((other) => wordsMatch(word, other));
    if (at < 0) return false;
    free.splice(at, 1);
  }
  return whole;
}

/**
 * Whether the people in the call are covered by their own Bee. Not in a sync: uncovered. In a sync with no roster from the
 * meeting window, or one that may be cut off at the reader's cap: unknown. Otherwise covered when every name but the user's
 * own matches a sync member. Uncovered and unknown both mean Bee should listen.
 */
export function teamsAudioCoverage(args: {
  inRoom: boolean;
  /** Display names of the sync's members, the user included. */
  members: readonly string[];
  /** The user's own display name, if known. */
  self: string | null;
  /** Names from the Teams call window's roster, or null when the reader has none. */
  participants: readonly string[] | null;
}): TeamsAudioCoverage {
  if (!args.inRoom) return "uncovered";
  const people = args.participants ?? [];
  if (people.length === 0 || people.length >= PARTICIPANTS_MAX) return "unknown";
  const others = people.filter((name) => !(args.self && namesMatch(name, args.self)));
  return others.every((name) => args.members.some((member) => namesMatch(name, member))) ? "covered" : "uncovered";
}

// ---- When to listen ----

/** off: setting off. unavailable: no Teams-only capture here. waiting: no Teams call, or the mic is off. covered: everyone has Bee. */
export type TeamsAudioPlan = "off" | "unavailable" | "waiting" | "covered" | "listen";

export function teamsAudioPlan(args: { enabled: boolean; supported: boolean; teamsCall: boolean; micOn: boolean; coverage: TeamsAudioCoverage }): TeamsAudioPlan {
  if (!args.enabled) return "off";
  if (!args.supported) return "unavailable";
  if (!args.teamsCall || !args.micOn) return "waiting";
  return args.coverage === "covered" ? "covered" : "listen";
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
 * them up), a teammate's from their own Bee, or a live caption. Those name the speaker, so the Teams-audio copy is dropped.
 */
export function teamsAudioEcho(text: string, lines: readonly SessionLine[], now: number): boolean {
  const recent = lines.filter((line) => !isTeamsAudioLine(line) && Math.abs(now - line.clientTs) < TEAMS_AUDIO_ECHO_MS).map((line) => line.text);
  return echoesOwnLine(text, recent);
}

/**
 * Teams-audio lines that an incoming teammate or caption line repeats (it arrived later, from the relay or the caption poll).
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
