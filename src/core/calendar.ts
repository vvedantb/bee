// Today's events from the desktop Outlook calendar. Classic Outlook only, through its COM object model from a PowerShell child
// process (main/local-readers.ts). No Microsoft Graph, no sign-in, no network: everything is read on this device.
// This file is pure: the reader interface, the script, the parser and the back-off guard.

export type CalendarEvent = {
  subject: string;
  /** ISO 8601, UTC. */
  start: string;
  end: string;
  organizer: string;
  required: string[];
  optional: string[];
  location: string;
  /** Agenda text, already stripped of HTML and join links and cut to BODY_MAX_CHARS. */
  body: string;
  /** Part of a recurring series. Absent when the reader did not say. */
  recurring?: boolean;
};

export type CalendarReadResult = { ok: true; events: CalendarEvent[] } | { ok: false; disabled: true; reason: string };
export type CalendarReader = { readToday: (now?: Date) => Promise<CalendarReadResult> };

export const BODY_MAX_CHARS = 1200;
const SUBJECT_MAX = 200;
const NAME_MAX = 80;
const LOCATION_MAX = 120;
const PEOPLE_MAX = 30;
const EVENTS_MAX = 50;
// The script reads a little more than the cap, so truncation here is what decides the length.
export const SCRIPT_BODY_READ_CHARS = 4000;

/**
 * PowerShell for Windows PowerShell 5.1. It attaches to a RUNNING Outlook (GetActiveObject), so Bee never starts Outlook.
 * It prints one JSON object: { status: "ok" | "not-running" | "error", events, message }. Never writes to Outlook.
 * Placeholders: __FROM__ and __TO__ (local day bounds, ISO), __BODY__ (characters of body to read).
 */
export const OUTLOOK_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Emit($status, $events, $message) {
  $result = [ordered]@{ status = $status; message = $message; events = @($events) }
  Write-Output (ConvertTo-Json -InputObject $result -Depth 5 -Compress)
}
try {
  try { $outlook = [System.Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application') }
  catch { Emit 'not-running' @() 'Outlook is not running'; exit 0 }
  $calendar = $outlook.GetNamespace('MAPI').GetDefaultFolder(9)
  $items = $calendar.Items
  $items.IncludeRecurrences = $true
  $items.Sort('[Start]')
  $from = [DateTime]::Parse('__FROM__')
  $to = [DateTime]::Parse('__TO__')
  $format = 'g'
  $filter = "[Start] < '" + $to.ToString($format) + "' AND [End] > '" + $from.ToString($format) + "'"
  $found = @()
  foreach ($item in $items.Restrict($filter)) {
    if ($found.Count -ge ${EVENTS_MAX}) { break }
    $body = [string]$item.Body
    if ($body.Length -gt __BODY__) { $body = $body.Substring(0, __BODY__) }
    $found += [ordered]@{
      subject = [string]$item.Subject
      start = $item.Start.ToUniversalTime().ToString('o')
      end = $item.End.ToUniversalTime().ToString('o')
      organizer = [string]$item.Organizer
      required = [string]$item.RequiredAttendees
      optional = [string]$item.OptionalAttendees
      location = [string]$item.Location
      body = $body
      recurring = [bool]$item.IsRecurring
    }
  }
  Emit 'ok' $found ''
} catch {
  Emit 'error' @() ([string]$_.Exception.Message)
}
`.trim();

/** The script with the local day's bounds filled in. */
export function outlookScriptFor(now: Date): string {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  const local = (date: Date) => {
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00`;
  };
  return OUTLOOK_SCRIPT.replaceAll("__FROM__", local(start)).replaceAll("__TO__", local(end)).replaceAll("__BODY__", String(SCRIPT_BODY_READ_CHARS));
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Plain text from HTML: drops style, script and tags, turns block ends into line breaks, decodes common entities. */
export function stripHtml(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
      if (entity[0] === "#") {
        const code = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : " ";
      }
      return ENTITIES[entity.toLowerCase()] ?? match;
    });
}

// Where Teams and Outlook append the join block: links, meeting ids and passcodes. None of it is agenda, and none goes to a model.
const JOIN_BLOCK = /(_{8,}|Microsoft Teams (?:Need help|meeting)|Join (?:on your computer|the meeting now|with a video)|Meeting ID:|Passcode:|Dial in by phone|Or call in)/i;

/** Agenda text from an event body: HTML stripped, join block and links removed, spaces collapsed, cut to `max` characters. */
export function agendaFromBody(raw: string, max = BODY_MAX_CHARS): string {
  const text = stripHtml(raw).replace(/\r/g, "");
  const cut = JOIN_BLOCK.exec(text);
  const agenda = (cut ? text.slice(0, cut.index) : text)
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[ \t ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return agenda.length > max ? `${agenda.slice(0, max - 1).trimEnd()}…` : agenda;
}

const text = (value: unknown, max: number): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Outlook gives "Alice; Bob" for attendees. An array is accepted too. */
export function splitPeople(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[;\n]/) : [];
  const names = items.map((item) => text(item, NAME_MAX)).filter((name) => name.length > 0);
  return [...new Set(names)].slice(0, PEOPLE_MAX);
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** One event from the script's JSON, or null when it has no usable start and end. */
export function parseCalendarEvent(item: unknown, maxBody = BODY_MAX_CHARS): CalendarEvent | null {
  if (typeof item !== "object" || item === null) return null;
  const raw = item as Record<string, unknown>;
  const start = isoOrNull(raw.start);
  const end = isoOrNull(raw.end);
  if (!start || !end || Date.parse(end) < Date.parse(start)) return null;
  const event: CalendarEvent = {
    subject: text(raw.subject, SUBJECT_MAX),
    start,
    end,
    organizer: text(raw.organizer, NAME_MAX),
    required: splitPeople(raw.required),
    optional: splitPeople(raw.optional),
    location: text(raw.location, LOCATION_MAX),
    body: typeof raw.body === "string" ? agendaFromBody(raw.body, maxBody) : "",
  };
  if (typeof raw.recurring === "boolean") event.recurring = raw.recurring;
  return event;
}

/**
 * The script's stdout. "ok" gives the events, soonest first. "not-running" is no events (Outlook may start later).
 * An error, or output that is not the expected JSON (no PowerShell, a prompt text), disables the reader.
 */
export function parseOutlookOutput(stdout: string, maxBody = BODY_MAX_CHARS): CalendarReadResult {
  // PowerShell may print warnings before the JSON line: use the last line that starts the object.
  const line = stdout.split(/\r?\n/).map((part) => part.trim()).filter((part) => part.startsWith("{")).pop();
  if (!line) return { ok: false, disabled: true, reason: "no calendar output" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, disabled: true, reason: "unreadable calendar output" };
  }
  if (typeof parsed !== "object" || parsed === null) return { ok: false, disabled: true, reason: "unreadable calendar output" };
  const { status, events, message } = parsed as { status?: unknown; events?: unknown; message?: unknown };
  if (status === "not-running") return { ok: true, events: [] };
  if (status !== "ok") return { ok: false, disabled: true, reason: text(message, 160) || "Outlook calendar unavailable" };
  const list = Array.isArray(events) ? events : events === undefined || events === null ? [] : [events];
  const parsedEvents = list.slice(0, EVENTS_MAX).flatMap((item) => parseCalendarEvent(item, maxBody) ?? []);
  parsedEvents.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return { ok: true, events: parsedEvents };
}

/** Reader for platforms without classic Outlook COM. */
export const unsupportedCalendarReader: CalendarReader = {
  readToday: async () => ({ ok: false, disabled: true, reason: "not windows" }),
};

/**
 * Back-off for Outlook. The first failure (a security prompt that times out, COM missing, any error) disables calendar reads
 * for the rest of the session, so a prompt never appears in a loop. A reader that throws counts as a failure.
 */
export function guardCalendarReader(reader: CalendarReader): CalendarReader & { disabledReason: () => string | null } {
  let disabled: string | null = null;
  return {
    disabledReason: () => disabled,
    readToday: async (now) => {
      if (disabled !== null) return { ok: false, disabled: true, reason: disabled };
      let result: CalendarReadResult;
      try {
        result = await reader.readToday(now);
      } catch (error) {
        result = { ok: false, disabled: true, reason: error instanceof Error ? error.message.slice(0, 160) : "calendar read failed" };
      }
      if (!result.ok) disabled = result.reason;
      return result;
    },
  };
}
