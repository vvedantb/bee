import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  BODY_MAX_CHARS,
  OUTLOOK_SCRIPT,
  agendaFromBody,
  guardCalendarReader,
  outlookScriptFor,
  parseOutlookOutput,
  splitPeople,
  stripHtml,
  unsupportedCalendarReader,
  type CalendarReader,
} from "./calendar";

const fixture = readFileSync(new URL("../../test/fixtures/outlook-calendar.json", import.meta.url), "utf8");

describe("parseOutlookOutput (PowerShell fixture)", () => {
  const result = parseOutlookOutput(fixture);

  it("parses the events, soonest first, and skips one with a bad date", () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events.map((event) => event.subject)).toEqual(["Weekly Sync", "1:1 Priya / Vedant", "Long agenda"]);
    expect(result.events[0]).toMatchObject({ start: "2026-10-17T13:00:00.000Z", end: "2026-10-17T13:30:00.000Z", organizer: "Priya Nair", location: "Microsoft Teams Meeting", recurring: true });
  });

  it("splits attendees from a semicolon string or an array", () => {
    if (!result.ok) throw new Error("expected events");
    expect(result.events[0]?.required).toEqual(["Priya Nair", "Sam Okafor", "Vedant B"]);
    expect(result.events[0]?.optional).toEqual(["Lee Chen"]);
    expect(result.events[2]?.required).toEqual(["Sam Okafor", "Vedant B"]);
    expect(result.events[1]?.optional).toEqual([]);
  });

  it("strips HTML from the body and drops the Teams join block, links and passcode", () => {
    if (!result.ok) throw new Error("expected events");
    const body = result.events[0]?.body ?? "";
    expect(body).toContain("Pipeline review & forecast");
    expect(body).toContain("Renewal: Acme Ltd");
    expect(body).not.toMatch(/<|style|color:red|https?:|Passcode|Meeting ID|teams\.microsoft/i);
  });

  it("truncates a long body", () => {
    if (!result.ok) throw new Error("expected events");
    const long = result.events[2]?.body ?? "";
    expect(long.length).toBeLessThanOrEqual(BODY_MAX_CHARS);
    const short = parseOutlookOutput(fixture, 100);
    if (!short.ok) throw new Error("expected events");
    expect(short.events[2]?.body.length).toBe(100);
    expect(short.events[2]?.body.endsWith("…")).toBe(true);
  });
});

describe("parseOutlookOutput statuses", () => {
  it("treats Outlook not running as no events, not as a failure", () => {
    expect(parseOutlookOutput('{"status":"not-running","message":"Outlook is not running","events":[]}')).toEqual({ ok: true, events: [] });
  });

  it("disables on an error status, naming the reason", () => {
    expect(parseOutlookOutput('{"status":"error","message":"Retrieving the COM class factory failed","events":[]}')).toEqual({
      ok: false,
      disabled: true,
      reason: "Retrieving the COM class factory failed",
    });
  });

  it("disables on empty or unreadable output", () => {
    expect(parseOutlookOutput("")).toMatchObject({ ok: false, disabled: true });
    expect(parseOutlookOutput("{broken")).toMatchObject({ ok: false, disabled: true });
  });

  it("ignores warning lines before the JSON", () => {
    expect(parseOutlookOutput('WARNING: slow\n{"status":"ok","events":[]}')).toEqual({ ok: true, events: [] });
  });

  it("accepts one event that PowerShell did not wrap in an array", () => {
    const one = '{"status":"ok","events":{"subject":"A","start":"2026-10-17T10:00:00Z","end":"2026-10-17T11:00:00Z"}}';
    const result = parseOutlookOutput(one);
    expect(result.ok && result.events).toHaveLength(1);
  });
});

describe("text helpers", () => {
  it("stripHtml removes tags, styles and decodes entities", () => {
    expect(stripHtml("<style>x{}</style><p>A &amp; B&#33;</p>").replace(/\s+/g, " ").trim()).toBe("A & B!");
  });

  it("agendaFromBody keeps the agenda before the join block", () => {
    expect(agendaFromBody("Review the plan.\n\nJoin the meeting now https://x.example/join")).toBe("Review the plan.");
  });

  it("splitPeople trims, dedupes and caps", () => {
    expect(splitPeople(" A ; B;A;; ")).toEqual(["A", "B"]);
    expect(splitPeople(Array.from({ length: 50 }, (_, n) => `P${n}`))).toHaveLength(30);
    expect(splitPeople(undefined)).toEqual([]);
  });
});

describe("outlookScriptFor", () => {
  it("fills the day bounds and reads a running Outlook only", () => {
    const script = outlookScriptFor(new Date(2026, 9, 17, 14, 0));
    expect(script).toContain("2026-10-17T00:00:00");
    expect(script).toContain("2026-10-18T00:00:00");
    expect(script).not.toMatch(/__\w+__/);
    expect(script).toContain("GetActiveObject");
    expect(OUTLOOK_SCRIPT).toContain("IncludeRecurrences");
    expect(OUTLOOK_SCRIPT).not.toMatch(/New-Object -ComObject|\.Send\(|\.Delete\(|\.Save\(/);
  });
});

describe("guardCalendarReader", () => {
  it("stops reading Outlook after the first failure, for the session", async () => {
    const readToday = vi.fn<CalendarReader["readToday"]>().mockResolvedValue({ ok: false, disabled: true, reason: "timed out" });
    const guarded = guardCalendarReader({ readToday });
    expect(await guarded.readToday()).toEqual({ ok: false, disabled: true, reason: "timed out" });
    expect(await guarded.readToday()).toEqual({ ok: false, disabled: true, reason: "timed out" });
    expect(readToday).toHaveBeenCalledTimes(1);
    expect(guarded.disabledReason()).toBe("timed out");
  });

  it("counts a thrown error as a failure", async () => {
    const readToday = vi.fn<CalendarReader["readToday"]>().mockRejectedValue(new Error("boom"));
    const guarded = guardCalendarReader({ readToday });
    expect(await guarded.readToday()).toMatchObject({ ok: false, reason: "boom" });
    await guarded.readToday();
    expect(readToday).toHaveBeenCalledTimes(1);
  });

  it("keeps reading while it succeeds", async () => {
    const readToday = vi.fn<CalendarReader["readToday"]>().mockResolvedValue({ ok: true, events: [] });
    const guarded = guardCalendarReader({ readToday });
    await guarded.readToday();
    await guarded.readToday();
    expect(readToday).toHaveBeenCalledTimes(2);
    expect(guarded.disabledReason()).toBeNull();
  });

  it("the non-Windows reader is disabled", async () => {
    expect(await unsupportedCalendarReader.readToday()).toEqual({ ok: false, disabled: true, reason: "not windows" });
  });
});
