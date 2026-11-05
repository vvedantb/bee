import { safeExternalUrl } from "./url-safety";

// Desktop actions for a direct request ("Bee, open Teams"): which app a name means, what is refused, and which requests need
// no AI at all. Pure: main/desktop-actions.ts runs them on macOS, Windows and Linux. Bee only opens or brings forward apps and
// opens web pages. It never clicks, types, sends, closes or changes anything in another app.

/** What a desktop action did, as the short line the island shows, with no end stop ("Opened Teams", "Could not find Figma"). */
export type DesktopActionResult = { ok: boolean; message: string };

/** The runners behind Bee's desktop tools. Main implements them (main/desktop-actions.ts); tests pass fakes. */
export type DesktopActions = {
  openApp: (name: string) => Promise<DesktopActionResult>;
  focusWindow: (target: { app: string; title?: string }) => Promise<DesktopActionResult>;
  openUrl: (url: string) => Promise<DesktopActionResult>;
};

export const APP_NAME_MAX = 60;
export const WINDOW_TITLE_MAX = 120;

/**
 * How each OS finds an app: macOS by display name (open -a); Windows by a fixed URI, a Start menu shortcut or a system exe; Linux
 * by desktop-entry names through agent-desktop launch (core/app-discovery.ts linuxLaunchNames), tried in order.
 */
export type AppTarget = {
  label: string;
  mac: string | null;
  win: { uri?: string; startMenu: string[]; exe?: string } | null;
  linux: string[];
  known: boolean;
};

type KnownApp = Omit<AppTarget, "known" | "win" | "linux"> & {
  aliases: string[];
  win: { uri?: string; startMenu?: string[]; exe?: string } | null;
  /** Desktop-entry names on Linux, most common first. Absent: only the name as said is tried. */
  linux?: string[];
};

// Apps people ask for by a short name. A name not listed here is still tried as given (Start menu or open -a). Windows URIs
// and exes are fixed here, never taken from the model.
const KNOWN_APPS: readonly KnownApp[] = [
  { label: "Teams", aliases: ["teams", "team", "microsoft teams", "ms teams"], mac: "Microsoft Teams", win: { uri: "msteams:", startMenu: ["Microsoft Teams", "Teams"] } },
  { label: "Outlook", aliases: ["outlook", "microsoft outlook"], mac: "Microsoft Outlook", win: { startMenu: ["Outlook", "Outlook (classic)", "Outlook (new)"] } },
  { label: "Word", aliases: ["word", "microsoft word"], mac: "Microsoft Word", win: { startMenu: ["Word"] } },
  { label: "Excel", aliases: ["excel", "microsoft excel"], mac: "Microsoft Excel", win: { startMenu: ["Excel"] } },
  { label: "PowerPoint", aliases: ["powerpoint", "power point", "microsoft powerpoint"], mac: "Microsoft PowerPoint", win: { startMenu: ["PowerPoint"] } },
  { label: "OneNote", aliases: ["onenote", "one note", "microsoft onenote"], mac: "Microsoft OneNote", win: { startMenu: ["OneNote"] } },
  { label: "Slack", aliases: ["slack"], mac: "Slack", win: { startMenu: ["Slack"] }, linux: ["slack"] },
  { label: "Zoom", aliases: ["zoom", "zoom workplace"], mac: "zoom.us", win: { startMenu: ["Zoom Workplace", "Zoom"] }, linux: ["zoom"] },
  { label: "Chrome", aliases: ["chrome", "google chrome"], mac: "Google Chrome", win: { startMenu: ["Google Chrome"] }, linux: ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"] },
  { label: "Edge", aliases: ["edge", "microsoft edge"], mac: "Microsoft Edge", win: { startMenu: ["Microsoft Edge"] }, linux: ["microsoft-edge", "microsoft-edge-stable"] },
  { label: "Firefox", aliases: ["firefox", "mozilla firefox"], mac: "Firefox", win: { startMenu: ["Firefox", "Mozilla Firefox"] }, linux: ["firefox", "firefox-esr"] },
  { label: "Safari", aliases: ["safari"], mac: "Safari", win: null },
  { label: "Spotify", aliases: ["spotify"], mac: "Spotify", win: { uri: "spotify:", startMenu: ["Spotify"] }, linux: ["spotify"] },
  { label: "Notion", aliases: ["notion"], mac: "Notion", win: { startMenu: ["Notion"] } },
  { label: "VS Code", aliases: ["vs code", "vscode", "visual studio code"], mac: "Visual Studio Code", win: { startMenu: ["Visual Studio Code"] }, linux: ["code"] },
  { label: "Finder", aliases: ["finder"], mac: "Finder", win: null },
  { label: "File Explorer", aliases: ["file explorer", "explorer", "windows explorer"], mac: null, win: { startMenu: ["File Explorer"], exe: "explorer.exe" } },
  // Not plain "notes": that may mean the user's own notes, so the AI decides.
  { label: "Notes", aliases: ["apple notes"], mac: "Notes", win: null },
  { label: "Notepad", aliases: ["notepad"], mac: null, win: { exe: "notepad.exe" } },
  { label: "Calculator", aliases: ["calculator", "calc"], mac: "Calculator", win: { uri: "calculator:" }, linux: ["gnome-calculator", "org.gnome.Calculator", "galculator", "kcalc"] },
  { label: "Calendar", aliases: ["calendar", "apple calendar"], mac: "Calendar", win: null, linux: ["gnome-calendar", "org.gnome.Calendar"] },
  { label: "Mail", aliases: ["mail", "apple mail"], mac: "Mail", win: null, linux: ["thunderbird", "evolution"] },
  { label: "LibreOffice", aliases: ["libreoffice", "libre office"], mac: "LibreOffice", win: { startMenu: ["LibreOffice"] }, linux: ["libreoffice", "libreoffice-startcenter"] },
  { label: "LibreOffice Writer", aliases: ["libreoffice writer", "libre office writer"], mac: "LibreOffice", win: { startMenu: ["LibreOffice Writer"] }, linux: ["libreoffice-writer"] },
  { label: "LibreOffice Calc", aliases: ["libreoffice calc", "libre office calc"], mac: "LibreOffice", win: { startMenu: ["LibreOffice Calc"] }, linux: ["libreoffice-calc"] },
  // Linux file managers. Not plain "files": that may mean the user's own files, so the AI decides.
  { label: "File manager", aliases: ["file manager", "thunar", "nautilus"], mac: null, win: null, linux: ["thunar", "nautilus", "org.gnome.Nautilus", "nemo", "dolphin", "pcmanfm"] },
];

// Shells, script hosts and system tools Bee never opens, whatever the request: one more step and they run anything.
const BLOCKED_APPS = new Set(
  [
    "terminal", "iterm", "iterm2", "warp", "ghostty", "alacritty", "kitty", "hyper", "console",
    "cmd", "cmd.exe", "command prompt", "powershell", "pwsh", "windows powershell", "windows terminal", "wt",
    "bash", "sh", "zsh", "fish", "wsl", "ubuntu",
    "script editor", "automator", "osascript", "shortcuts", "wscript", "cscript", "mshta", "rundll32", "regedit",
    "registry editor", "task scheduler", "keychain access", "passwords", "logoff", "shutdown",
  ].map((name) => name.toLowerCase()),
);

export const BLOCKED_APP_MESSAGE = "Bee does not open terminals, script tools or system tools";

/** A shell, script host or system tool Bee never opens, nor reads or types into for computer use (core/computer-tools.ts). */
export function isBlockedApp(name: string): boolean {
  return BLOCKED_APPS.has(appKey(name));
}

/** Lower case, single spaces, no "the" in front or "app" behind: the key app names are compared by. */
export function appKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^the /, "")
    .replace(/ (?:app|application|desktop app|window)$/, "")
    .replace(/\.(?:app|exe)$/, "")
    .trim();
}

// An app name: letters and digits, with spaces and a few marks inside. No path separators, quotes, colons or shell marks, and
// never a leading "-" (it would read as a flag) or "." (a hidden or relative path).
const APP_NAME = /^[\p{L}\p{N}][\p{L}\p{N} .&+'’()-]*$/u;

/** The app name as Bee will use it, or null when it is not a plain name (a path, a URL, a flag, too long). */
export function cleanAppName(raw: string): string | null {
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  const name = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“‘]+|["'”’.,!?;:]+$/gu, "")
    .replace(/^the /i, "")
    .replace(/ (?:app|application|window)$/i, "")
    .trim();
  if (name.length === 0 || name.length > APP_NAME_MAX || name.includes("..") || !APP_NAME.test(name)) return null;
  // Arguments are never shell text here, but a chained command or a flag after a space is not an app name either.
  if (/&&|\s-/.test(name)) return null;
  return name;
}

/** The known app for a name, by its aliases ("teams", "Microsoft Teams", "the Teams app"). */
function knownApp(name: string): KnownApp | null {
  const key = appKey(name);
  return KNOWN_APPS.find((app) => app.aliases.includes(key)) ?? null;
}

/**
 * Where to find the app a request names, or why not: not a plain name, or a shell or script tool. A name Bee does not know is
 * used as given, on macOS by display name and on Windows by Start menu shortcut name.
 */
export function resolveApp(raw: string): { ok: true; app: AppTarget } | { ok: false; message: string } {
  const name = cleanAppName(raw);
  if (!name) return { ok: false, message: "That is not an app name Bee can open" };
  if (BLOCKED_APPS.has(appKey(name))) return { ok: false, message: BLOCKED_APP_MESSAGE };
  const known = knownApp(name);
  if (known) return { ok: true, app: { label: known.label, mac: known.mac, win: known.win && { ...known.win, startMenu: known.win.startMenu ?? [] }, linux: known.linux ?? [], known: true } };
  return { ok: true, app: { label: name, mac: name, win: { startMenu: [name] }, linux: [], known: false } };
}

/** The names a running app may be listed under (agent-desktop list-apps), as appKey values. */
export function appNames(app: AppTarget): string[] {
  const known = KNOWN_APPS.find((item) => item.label === app.label && app.known);
  const names = [app.label, app.mac ?? "", ...(app.win?.startMenu ?? []), ...(app.win?.exe ? [app.win.exe] : []), ...(app.linux ?? []), ...(known?.aliases ?? [])];
  return [...new Set(names.map(appKey).filter((name) => name.length > 0))];
}

/**
 * The running app that matches, from list-apps names: an exact name first, then one that starts with a known name ("Microsoft
 * Teams (work or school)"). Null when none does.
 */
export function matchRunningApp<T extends { name: string }>(app: AppTarget, running: readonly T[]): T | null {
  const names = appNames(app);
  const exact = running.find((item) => names.includes(appKey(item.name)));
  if (exact) return exact;
  return running.find((item) => names.some((name) => name.length >= 3 && appKey(item.name).startsWith(`${name} `))) ?? null;
}

/** A clean window title, or null: one line, no control characters, not too long. */
export function cleanWindowTitle(raw: string | undefined): string | null {
  const title = (raw ?? "").replace(/\s+/g, " ").trim();
  if (title.length === 0 || title.length > WINDOW_TITLE_MAX || /[\u0000-\u001f\u007f]/.test(title) || title.startsWith("-")) return null;
  return title;
}

const URL_SHOWN_MAX = 80;

/** "Opened https://www.bbc.co.uk/news", cut to fit the island. */
export function openedUrlMessage(url: string): string {
  const shown = url.length > URL_SHOWN_MAX ? `${url.slice(0, URL_SHOWN_MAX - 1)}…` : url;
  return `Opened ${shown}`;
}

// A bare domain or URL as said or typed: "bbc.co.uk", "www.bbc.co.uk/news", "https://example.com/a?b".
const BARE_URL = /^(?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?(?:[/?#]\S*)?$/i;
// Without a scheme or "www.", only these endings read as a web address, so "notes.md" or "deck.pptx" never opens a site.
const WEB_ENDINGS = new Set(["com", "org", "net", "io", "co", "uk", "dev", "app", "ai", "gov", "edu", "us", "eu", "de", "fr", "nl", "ie", "in", "ca", "au", "info", "me", "tv", "news"]);

/** The web page a request names, as a safe https or http URL, or null. A bare domain gets https. */
export function requestedUrl(raw: string): string | null {
  const text = raw.trim().replace(/[.,!?;:]+$/, "");
  if (!BARE_URL.test(text)) return null;
  const explicit = /^https?:\/\//i.test(text);
  const host = (text.replace(/^https?:\/\//i, "").split(/[/?#:]/)[0] ?? "").toLowerCase();
  if (!explicit && !host.startsWith("www.") && !WEB_ENDINGS.has(host.split(".").at(-1) ?? "")) return null;
  return safeExternalUrl(explicit ? text : `https://${text}`);
}

/** How Bee handles a direct request: a desktop action it can do at once, without the AI, or an answer from the AI. */
export type CommandRoute = { kind: "open-app"; name: string } | { kind: "focus-app"; name: string } | { kind: "open-url"; url: string } | { kind: "ai" };

const OPEN = /^(?:open|launch|start|run|load)\s+(?:up\s+)?(.+)$/i;
const FOCUS = /^(?:switch\s+to|go\s+to|focus(?:\s+on)?|bring\s+up|bring\s+forward|pull\s+up|show(?:\s+me)?)\s+(.+)$/i;
// Polite padding around a request: "please open Teams", "can you open Teams for me", "open Teams now please".
const PADDING_START = /^(?:(?:please|can\s+you|could\s+you|would\s+you|will\s+you|just|now)[\s,]+)+/i;
const PADDING_END = /(?:[\s,]+(?:please|for\s+me|now|thanks|thank\s+you))+$/i;

/** The request without quotes, polite padding and end punctuation. */
function plainRequest(command: string): string {
  return command
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“‘]+|["'”’]+$/gu, "")
    .replace(/[.!?]+$/, "")
    .replace(PADDING_START, "")
    .replace(PADDING_END, "")
    .trim();
}

/**
 * A request that is only "open <a known app>", "switch to <a known app>" or "open <a web address>" runs at once, with no AI
 * call. Anything else (an app Bee does not know, two steps, a question) goes to the AI, which may still call the desktop tools.
 */
export function routeCommand(command: string): CommandRoute {
  const text = plainRequest(command);
  const open = OPEN.exec(text);
  const focus = open ? null : FOCUS.exec(text);
  const target = (open ?? focus)?.[1]?.trim();
  if (!target) return { kind: "ai" };
  const url = requestedUrl(target);
  if (url) return { kind: "open-url", url };
  const known = knownApp(cleanAppName(target) ?? "");
  if (!known) return { kind: "ai" };
  return open ? { kind: "open-app", name: known.label } : { kind: "focus-app", name: known.label };
}
