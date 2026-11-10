import type { AdApp, AdNode, AdWindow } from "./agent-desktop-envelope";
import type { DetectorReading } from "./teams-heuristics";
import { isMeetingTitle, meetingCandidate, type MeetingCandidate } from "./teams-heuristics";
import { parseTeamsTitle } from "./teams-title";

// Experimental meeting window reader, pure parts: which Teams, Zoom or Google Meet window is a call (from agent-desktop's
// list-apps and list-windows), the people and live caption lines a call window shows in its accessibility tree, and caption
// dedupe. main/meeting-window-reader.ts runs the commands. Nothing here logs or stores what it reads.

export type MeetingApp = "teams" | "zoom" | "meet";

/**
 * A window that reads like a call. name: the meeting's own name when the title carries one (never for Zoom). pid and bundleId:
 * the owning process and its macOS bundle id when agent-desktop reports them, so call audio can hear that app alone.
 */
export type MeetingWindow = {
  app: MeetingApp;
  appName: string;
  windowId: string;
  title: string;
  name: string | null;
  focused: boolean;
  pid: number | null;
  bundleId: string | null;
};

export const APP_LABEL: Record<MeetingApp, string> = { teams: "Teams", zoom: "Zoom", meet: "Google Meet" };

const ZERO_WIDTH = /[​-‏⁠﻿]/g;
const appKey = (name: string): string => name.replace(ZERO_WIDTH, "").trim().toLowerCase().replace(/\.exe$/, "");

const TEAMS_NAMES = /^(microsoft teams( classic| \(work or school\)| \(personal\))?|msteams|ms-teams|teams)$/;
const ZOOM_NAMES = /^(zoom\.us|zoom|zoom workplace|zoom meetings|zoom cloud meetings)$/;
const BROWSER_NAMES =
  /^(google chrome( beta| dev| canary)?|chrome|chromium|microsoft edge( beta| dev| canary)?|msedge|arc|safari( technology preview)?|firefox|mozilla firefox|firefox developer edition|brave( browser)?|vivaldi|opera|zen( browser)?)$/;
const BROWSER_BUNDLES = /^(com\.google\.chrome|org\.chromium\.chromium|com\.microsoft\.edgemac|company\.thebrowser\.browser|com\.apple\.safari|org\.mozilla\.firefox|com\.brave\.browser|com\.vivaldi\.vivaldi|com\.operasoftware\.opera|app\.zen-browser)/;

/** Which kind of app owns a window, by app name and (from list-apps) bundle id. */
export function appKind(name: string, bundleId: string | null = null): MeetingApp | "browser" | null {
  const key = appKey(name);
  const bundle = (bundleId ?? "").toLowerCase();
  if (TEAMS_NAMES.test(key) || bundle.startsWith("com.microsoft.teams")) return "teams";
  if (ZOOM_NAMES.test(key) || bundle === "us.zoom.xos") return "zoom";
  if (BROWSER_NAMES.test(key) || BROWSER_BUNDLES.test(bundle)) return "browser";
  return null;
}

// Zoom's call window ("Zoom Meeting", "Zoom Meeting 40-Minutes", "Zoom Webinar") and its pop-out roster ("Participants (4)").
const ZOOM_CALL = /^(zoom (meeting|webinar)\b|participants\s*\(\d+\)|.*\bmeeting in progress\b)/i;

/** A Zoom window that reads like a call. Its title never names the meeting. */
export function isZoomCallTitle(title: string): boolean {
  return ZOOM_CALL.test(title.replace(ZERO_WIDTH, "").trim());
}

const SEPARATOR = /\s+[-–—|]\s+/;
const BROWSER_PART = /^(google chrome|chromium|microsoft edge|mozilla firefox|firefox|safari|arc|brave|vivaldi|opera|zen)\b/i;
const MORE_TABS = /\s+and \d+ more (pages?|tabs?)$/i;
const MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i;
const MEET_GENERIC = /^(google meet|meet|home|landing|video calls and meetings( for business)?|meeting ended|you left the meeting)$/i;

/** The meeting in a browser window title, e.g. "Meet - abc-defg-hij - Google Chrome". Null when it is not a Meet call. */
export function parseMeetTitle(title: string): { name: string; generic: boolean } | null {
  const parts = title.replace(ZERO_WIDTH, "").trim().split(SEPARATOR);
  // The browser adds its name, and sometimes a profile after it: drop from the browser part on.
  const browserAt = parts.findIndex((part, index) => index > 0 && BROWSER_PART.test(part));
  const page = (browserAt > 0 ? parts.slice(0, browserAt) : parts).map((part) => part.replace(MORE_TABS, "").trim());
  let name = "";
  if (/^(google )?meet$/i.test(page[0] ?? "") && page.length > 1) name = page[1] ?? "";
  else if (page.length > 1 && /^google meet$/i.test(page[page.length - 1] ?? "")) name = page[0] ?? "";
  else {
    const colon = /^(?:google )?meet\s*:\s*(.+)$/i.exec(page[0] ?? "");
    name = colon?.[1] ?? "";
  }
  name = name.trim().slice(0, 200);
  if (!name || MEET_GENERIC.test(name)) return null;
  return { name, generic: MEET_CODE.test(name) };
}

/** A Teams title that names a meeting but does not say "meeting" or "call" ("Weekly Sync | Microsoft Teams"). Worth a light check. */
export function isPossibleTeamsCall(window: AdWindow): boolean {
  return appKind(window.app) === "teams" && !isMeetingTitle(window.title) && parseTeamsTitle(window.title) !== null;
}

/**
 * Call windows from list-windows. apps (list-apps) adds bundle ids by pid, for app names that do not say what they are.
 * confirmed: Teams window ids a light check found a Leave button in (see isPossibleTeamsCall).
 */
export function detectMeetings(args: { windows: readonly AdWindow[]; apps?: readonly AdApp[]; confirmed?: ReadonlySet<string> }): MeetingWindow[] {
  const bundles = new Map((args.apps ?? []).flatMap((app) => (app.pid !== null && app.bundleId ? [[app.pid, app.bundleId] as const] : [])));
  const found: MeetingWindow[] = [];
  for (const window of args.windows) {
    const bundleId = window.pid === null ? null : (bundles.get(window.pid) ?? null);
    const kind = appKind(window.app, bundleId);
    const base = { appName: window.app, windowId: window.id, title: window.title, focused: window.focused, pid: window.pid, bundleId };
    if (kind === "teams" && (isMeetingTitle(window.title) || args.confirmed?.has(window.id))) {
      const parsed = parseTeamsTitle(window.title);
      found.push({ ...base, app: "teams", name: parsed && !parsed.generic ? parsed.name : null });
    } else if (kind === "zoom" && isZoomCallTitle(window.title)) {
      found.push({ ...base, app: "zoom", name: null });
    } else if (kind === "browser") {
      const meet = parseMeetTitle(window.title);
      if (meet) found.push({ ...base, app: "meet", name: meet.generic ? null : meet.name });
    }
  }
  // The focused call first, so it is the one Bee reads.
  return found.sort((a, b) => Number(b.focused) - Number(a.focused));
}

/** The meeting windows as the sync controller and meeting context know them: one candidate per distinct meeting. */
export function meetingReading(meetings: readonly MeetingWindow[]): DetectorReading {
  const candidates = new Map<string, MeetingCandidate>();
  for (const meeting of meetings) {
    const candidate: MeetingCandidate =
      meeting.app === "teams"
        ? meetingCandidate(meeting.title)
        : meeting.app === "zoom"
          ? { key: "zoom meeting", title: meeting.title, label: "Zoom meeting" }
          : { key: `google meet ${(meeting.name ?? parseMeetTitle(meeting.title)?.name ?? "").toLowerCase()}`.trim(), title: meeting.title, label: `Google Meet${meeting.name ? `: ${meeting.name}` : ""}` };
    if (!candidates.has(candidate.key)) candidates.set(candidate.key, candidate);
  }
  return { inMeeting: meetings.length > 0, source: meetings.length > 0 ? "windows" : "none", meetings: [...candidates.values()] };
}

/** The built-in detector's reading plus the window reader's: in a meeting if either says so; meetings deduplicated by key. */
export function mergeReadings(own: DetectorReading, extra: DetectorReading): DetectorReading {
  const meetings = [...own.meetings];
  for (const candidate of extra.meetings) if (!meetings.some((known) => known.key === candidate.key)) meetings.push(candidate);
  const inMeeting = own.inMeeting || extra.inMeeting;
  return { inMeeting, source: own.source === "windows" || extra.source === "windows" ? "windows" : "none", meetings };
}

// ---- Accessibility tree: people and captions ----

const textOf = (node: AdNode): string => (node.name || node.value).replace(/\s+/g, " ").trim();

function* walk(node: AdNode): Generator<AdNode> {
  yield node;
  for (const child of node.children) yield* walk(child);
}

// Controls, not content. A "People" button or a "Turn on live captions" menu item names a region it does not hold.
const CONTROL_ROLE = /^(button|menuitem|menu|menubar|checkbox|switch|toggle|togglebutton|radio|radiobutton|tab|link|combobox|textfield|searchfield|slider|popupbutton|splitbutton|image|img)$/i;
const ROSTER = /\b(participants?|attendees|in this meeting|in the meeting|roster|people)\b/i;
const ITEM_ROLE = /^(listitem|treeitem|row|cell|outlineitem|gridcell)$/i;
// Words in roster headers and tile labels that are never part of a person's name.
const NOT_A_NAME =
  /\b(mute|muted|unmute|video|camera|mic|microphone|invite|invited|search|raise|raised|hand|share|sharing|chat|more|options|participants?|people|attendees|meeting|admit|waiting|lobby|suggest(ed|ions)?|others|presenters?|organi[sz]ers?|everyone|copy|link|close|captions?|transcript|record(ing)?|spotlight|pin(ned)?)\b/i;
const ROLE_SUFFIX = /\s*\b(organi[sz]er|presenter|attendee|co-host|host|guest|external|unverified|me|you)\s*$/i;
const PERSON = /^\p{L}[\p{L}\p{M}'’.\- ]{0,78}[\p{L}\p{M}.]$/u;

/** A person's name from a roster row or tile label ("Alice Smith (Guest), muted" → "Alice Smith"). Null for anything else. */
export function personName(raw: string): string | null {
  const bare = raw.replace(ZERO_WIDTH, "").replace(/\([^)]*\)|\[[^\]]*\]/g, " ").replace(/\s*\(.*$/, "");
  let name = (bare.replace(/\s+/g, " ").trim().split(/,|;|\s+[-–—|·]\s+/)[0] ?? "").trim();
  for (let i = 0; i < 2; i += 1) name = name.replace(ROLE_SUFFIX, "").trim();
  if (!PERSON.test(name) || NOT_A_NAME.test(name)) return null;
  const words = name.split(" ").length;
  return words >= 1 && words <= 5 ? name : null;
}

// Name particles that may stay lowercase in a capitalised name ("Ana de la Cruz").
const PARTICLE = /^(van|von|de|der|den|da|di|du|del|la|le|bin|al|el)$/i;

/** A speaker label in a caption row: a person's name, every word capitalised. "So the renewal" is caption text, not a name. */
function isSpeakerLabel(text: string): boolean {
  return /\p{L}$/u.test(text) && personName(text) === text && text.split(" ").every((word) => /^\p{Lu}/u.test(word) || PARTICLE.test(word));
}

// The window and its web page are never a roster or caption region, even when the meeting's name says "Transcript review".
const WINDOW_ROLE = /^(window|application|document|webarea|web area)$/i;
const isRegionCandidate = (node: AdNode, root: AdNode): boolean => node !== root && !CONTROL_ROLE.test(node.role) && !WINDOW_ROLE.test(node.role);

export const PARTICIPANTS_MAX = 20;

/** Names in the call window's roster (a list or group named Participants, People, In this meeting…). Up to 20, first seen first. */
export function extractParticipants(tree: AdNode | null): string[] {
  if (!tree) return [];
  const names = new Map<string, string>();
  for (const region of walk(tree)) {
    if (!isRegionCandidate(region, tree) || !ROSTER.test(`${region.name} ${region.description}`)) continue;
    const rows = [...walk(region)].filter((node) => node !== region && ITEM_ROLE.test(node.role));
    for (const row of rows.length > 0 ? rows : region.children) {
      const name = personName(textOf(row));
      if (name && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
      if (names.size >= PARTICIPANTS_MAX) return [...names.values()];
    }
  }
  return [...names.values()];
}

export type CaptionLine = { speaker: string | null; text: string };

const CAPTION_REGION = /\b(live captions?|captions?|subtitles?|closed captions?|live transcript(ion)?|transcript|cc)\b/i;
const CAPTION_CONTROL = /\b(turn (on|off)|show|hide|start|stop|settings|language|options|enable|disable|save|download|more|size|font|close)\b/i;
// A time stamp beside a transcript row ("10:02", "10:02 AM").
const CLOCK = /^\d{1,2}:\d{2}(:\d{2})?(\s?[ap]\.?m\.?)?$/i;
const SPEAKER_TEXT = /^([^:]{1,60}):\s+(.+)$/;
export const CAPTION_LINES_MAX = 50;

/** The lowest nodes that hold text leaves directly (a caption row), plus loose text leaves. */
function captionItems(node: AdNode, out: AdNode[]): void {
  // An avatar image without a name still sits beside the speaker label and the words.
  if (node.children.every((child) => child.children.length === 0) && node.children.some((child) => textOf(child))) {
    out.push(node);
    return;
  }
  for (const child of node.children) {
    if (child.children.length === 0) {
      if (textOf(child)) out.push({ ...child, children: [child] });
    } else {
      captionItems(child, out);
    }
  }
}

/** "Alice: words" → speaker and words, when the label is a name. */
function plainLine(text: string): CaptionLine {
  const labelled = SPEAKER_TEXT.exec(text);
  const speaker = labelled?.[1]?.trim();
  return speaker && labelled?.[2] && isSpeakerLabel(speaker) ? { speaker, text: labelled[2].trim() } : { speaker: null, text };
}

/**
 * One row: a speaker label and the words after it ("Alice Smith", "So the renewal…"), until the next label. Text before any
 * label is a line of its own, and may carry its label inline ("Alice: …").
 */
function rowLines(item: AdNode, regionName: string): CaptionLine[] {
  // Buttons inside the region (Close, Settings) are dropped by role; spoken words are never filtered by what they say.
  const texts = item.children
    .filter((child) => !CONTROL_ROLE.test(child.role))
    .map(textOf)
    .filter((part) => part && part !== regionName && !CLOCK.test(part));
  const lines: CaptionLine[] = [];
  let open: { speaker: string; words: string[] } | null = null;
  const close = () => {
    if (open && open.words.length > 0) lines.push({ speaker: open.speaker, text: open.words.join(" ") });
    open = null;
  };
  texts.forEach((text, index) => {
    if (isSpeakerLabel(text) && index < texts.length - 1) {
      close();
      open = { speaker: text, words: [] };
    } else if (open) {
      open.words.push(text);
    } else {
      lines.push(plainLine(text));
    }
  });
  close();
  return lines;
}

/** Caption lines shown in a live captions or transcript region, oldest first. Empty when captions are off or not exposed. */
export function extractCaptionLines(tree: AdNode | null): { visible: boolean; lines: CaptionLine[] } {
  if (!tree) return { visible: false, lines: [] };
  for (const region of walk(tree)) {
    if (!isRegionCandidate(region, tree) || region.children.length === 0) continue;
    if (!CAPTION_REGION.test(`${region.name} ${region.description}`) || CAPTION_CONTROL.test(region.name)) continue;
    const items: AdNode[] = [];
    captionItems(region, items);
    const lines = items.flatMap((item) => rowLines(item, region.name)).filter((line) => line.text.length > 1);
    if (lines.length > 0) return { visible: true, lines: lines.slice(-CAPTION_LINES_MAX) };
  }
  return { visible: false, lines: [] };
}

// ---- Skeleton and drill-down ----

/** Regions drilled per read of a call window, at most. */
export const DRILLS_MAX = 4;

/**
 * The refs to drill (snapshot --root) from a skeleton snapshot's data: nodes with both ref_id and children_count, which
 * agent-desktop marks as drill targets. A region named like a roster or captions comes first; then the largest containers
 * (the main content), up to `max`. Returned in tree order, so the drilled regions read in the order the window shows them.
 */
export function drillTargets(data: unknown, max = DRILLS_MAX): string[] {
  const found: Array<{ ref: string; region: boolean; count: number; order: number }> = [];
  let seen = 0;
  const visit = (raw: unknown, depth: number): void => {
    if (typeof raw !== "object" || raw === null || depth > 20 || seen >= 2000) return;
    seen += 1;
    const node = raw as Record<string, unknown>;
    const text = (key: string) => (typeof node[key] === "string" ? (node[key] as string) : "");
    const count = typeof node.children_count === "number" ? node.children_count : 0;
    const ref = text("ref_id");
    if (ref && count > 0 && !CONTROL_ROLE.test(text("role"))) {
      const label = `${text("name")} ${text("description")}`;
      found.push({ ref, region: ROSTER.test(label) || (CAPTION_REGION.test(label) && !CAPTION_CONTROL.test(text("name"))), count, order: found.length });
    }
    if (Array.isArray(node.children)) for (const child of node.children) visit(child, depth + 1);
  };
  if (typeof data === "object" && data !== null) visit((data as Record<string, unknown>).tree, 0);
  return found
    .sort((a, b) => Number(b.region) - Number(a.region) || b.count - a.count || a.order - b.order)
    .slice(0, max)
    .sort((a, b) => a.order - b.order)
    .map((target) => target.ref);
}

/** Drilled regions under one root, so extractParticipants and extractCaptionLines read them as they read a whole window. */
export function joinDrills(trees: readonly AdNode[]): AdNode {
  return { role: "window", name: "", value: "", description: "", children: [...trees] };
}

// ---- Caption dedupe ----

/** Lowercase words without punctuation, for comparing caption text across polls. */
export function captionKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();
}

/** 0 to 1: how many words two texts share (Dice score over word sets). */
export function wordOverlap(a: string, b: string): number {
  const left = new Set(captionKey(a).split(" ").filter((word) => word.length > 0));
  const right = new Set(captionKey(b).split(" ").filter((word) => word.length > 0));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

/** The text after its first `count` key words ("re-test it" holds the key words "re", "test", "it"). */
function dropWords(text: string, count: number): string {
  const words = text.split(/\s+/);
  let used = 0;
  let index = 0;
  while (index < words.length && used < count) {
    used += captionKey(words[index] ?? "").split(" ").filter((word) => word.length > 0).length;
    index += 1;
  }
  return words.slice(index).join(" ");
}

export type CaptionMemory = {
  /** False until the first read of a window: what it already shows is history, not new speech. */
  primed: boolean;
  /** Keys sent (or seen at priming), with when. */
  seen: Array<{ key: string; at: number }>;
  /** The last line's key at the previous read. A last line is sent once it stops changing. */
  lastKey: string | null;
};

export const EMPTY_CAPTIONS: CaptionMemory = { primed: false, seen: [], lastKey: null };
export const CAPTION_TIMING = { keepMs: 10 * 60_000, reviseMs: 60_000, keepMax: 300 };
// A line this close to one sent in the last minute is the captioner revising a word, not new speech.
const REVISION_OVERLAP = 0.8;

/**
 * New caption lines since the last read. A line is new once it is settled: a newer line follows it, or it read the same at
 * two reads in a row. Text seen before is dropped (by normalised words); a line that grew after it was sent gives only the
 * words it gained; a near-identical revision of a recent line is dropped.
 */
export function captionStep(memory: CaptionMemory, lines: readonly CaptionLine[], now: number): { memory: CaptionMemory; fresh: CaptionLine[] } {
  const keyed = lines.map((line) => ({ line, key: captionKey(line.text) })).filter((entry) => entry.key.length > 1);
  const lastKey = keyed[keyed.length - 1]?.key ?? null;
  let seen = memory.seen.filter((entry) => now - entry.at < CAPTION_TIMING.keepMs);
  if (!memory.primed) {
    seen = [...seen, ...keyed.map(({ key }) => ({ key, at: now }))].slice(-CAPTION_TIMING.keepMax);
    return { memory: { primed: true, seen, lastKey }, fresh: [] };
  }
  const fresh: CaptionLine[] = [];
  keyed.forEach(({ line, key }, index) => {
    const settled = index < keyed.length - 1 || key === memory.lastKey;
    if (!settled || seen.some((entry) => entry.key === key || entry.key.startsWith(`${key} `))) return;
    const grown = seen.filter((entry) => key.startsWith(`${entry.key} `)).sort((a, b) => b.key.length - a.key.length)[0];
    let text = line.text.trim();
    if (grown) {
      text = dropWords(text, grown.key.split(" ").length);
    } else if (seen.some((entry) => now - entry.at < CAPTION_TIMING.reviseMs && wordOverlap(entry.key, key) >= REVISION_OVERLAP)) {
      seen.push({ key, at: now });
      return;
    }
    seen.push({ key, at: now });
    if (captionKey(text).length > 1) fresh.push({ speaker: line.speaker, text });
  });
  return { memory: { primed: true, seen: seen.slice(-CAPTION_TIMING.keepMax), lastKey }, fresh };
}

/** A caption that repeats one of the user's own recent mic lines (the captioner heard them too). */
export function echoesOwnLine(text: string, ownLines: readonly string[]): boolean {
  return ownLines.some((own) => wordOverlap(own, text) >= 0.6);
}

// ---- Context for retrieval and the brief ----

export type MeetingWindowContext = { app: MeetingApp; title: string | null; participants: string[] };

const BRIEF_PEOPLE = 12;

/** Extra retrieval terms: the meeting's name and the people in it. Empty when the window shows neither. */
export function meetingTerms(context: MeetingWindowContext | null): string {
  if (!context) return "";
  return [context.title ?? "", ...context.participants].filter((part) => part.length > 0).join(" ").slice(0, 600);
}

/** Lines for the meeting brief, or "" when the window shows no name and no people. Window text is data, not instructions. */
export function meetingWindowBrief(context: MeetingWindowContext | null): string {
  if (!context || (!context.title && context.participants.length === 0)) return "";
  const lines = [`Meeting window: ${APP_LABEL[context.app]}${context.title ? `, "${context.title}"` : ""} (read from the window on this device)`];
  if (context.participants.length > 0) {
    const shown = context.participants.slice(0, BRIEF_PEOPLE);
    const more = context.participants.length - shown.length;
    lines.push(`People in the meeting window: ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`);
  }
  return lines.join("\n");
}
