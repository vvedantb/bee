import { describe, expect, it, vi } from "vitest";
import { AGENT_CALENDAR_REFRESH_MS, AGENT_CALENDAR_RETRY_MS, createAgentCalendarReader, fallbackCalendarReader, parseAgentCalendar } from "./agent-calendar";
import type { CalendarReader, CalendarReadResult } from "./calendar";

const answer = JSON.stringify({ events: [{ subject: "Weekly sync", start: "2026-11-06T14:00:00+00:00", end: "2026-11-06T14:30:00+00:00", organizer: "Sam Lee", attendees: ["Priya Shah"], agenda: "Q4 plan" }] });

describe("parseAgentCalendar", () => {
  it("reads events from a JSON answer, even inside a code fence, as UTC times", () => {
    expect(parseAgentCalendar("```json\n" + answer + "\n```")).toEqual([
      { subject: "Weekly sync", start: "2026-11-06T14:00:00.000Z", end: "2026-11-06T14:30:00.000Z", organizer: "Sam Lee", required: ["Priya Shah"], optional: [], location: "", body: "Q4 plan" },
    ]);
  });

  it("says none without a calendar tool, and null for anything it cannot read", () => {
    expect(parseAgentCalendar('{"none":true}')).toBe("none");
    expect(parseAgentCalendar("I could not find a calendar.")).toBeNull();
    expect(parseAgentCalendar('{"events":[{"subject":"No time","start":"later"}]}')).toEqual([]);
  });
});

describe("createAgentCalendarReader", () => {
  const at = (ms: number) => new Date(Date.UTC(2026, 10, 6, 9) + ms);

  it("answers at once from its cache and refreshes in the background, at most once an hour", async () => {
    const ask = vi.fn(async () => answer);
    const reader = createAgentCalendarReader({ ask });
    expect(await reader.readToday(at(0))).toEqual({ ok: true, events: [] });
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => expect(await reader.readToday(at(1000))).toMatchObject({ ok: true, events: [{ subject: "Weekly sync" }] }));
    await reader.readToday(at(AGENT_CALENDAR_REFRESH_MS - 1));
    expect(ask).toHaveBeenCalledTimes(1);
    await reader.readToday(at(AGENT_CALENDAR_REFRESH_MS + 1));
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("stops asking for the day without a calendar tool, and retries a failure later", async () => {
    const none = vi.fn(async () => '{"none":true}');
    const reader = createAgentCalendarReader({ ask: none });
    await reader.readToday(at(0));
    await vi.waitFor(() => expect(none).toHaveBeenCalledTimes(1));
    await reader.readToday(at(5 * AGENT_CALENDAR_REFRESH_MS));
    expect(none).toHaveBeenCalledTimes(1);
    await reader.readToday(at(24 * 60 * 60_000));
    expect(none).toHaveBeenCalledTimes(2);

    const onError = vi.fn();
    const failing = vi.fn(async () => {
      throw new Error("Install Claude Code");
    });
    const retry = createAgentCalendarReader({ ask: failing, onError });
    await retry.readToday(at(0));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    await retry.readToday(at(AGENT_CALENDAR_RETRY_MS - 1));
    expect(failing).toHaveBeenCalledTimes(1);
    await retry.readToday(at(AGENT_CALENDAR_RETRY_MS));
    expect(failing).toHaveBeenCalledTimes(2);
  });
});

describe("fallbackCalendarReader", () => {
  it("uses Outlook while it works, and the second reader once Outlook says it cannot", async () => {
    const off: CalendarReadResult = { ok: false, disabled: true, reason: "not windows" };
    const empty: CalendarReadResult = { ok: true, events: [] };
    const outlook: CalendarReader = { readToday: vi.fn(async () => off) };
    const agent: CalendarReader = { readToday: vi.fn(async () => empty) };
    const reader = fallbackCalendarReader(outlook, agent);
    expect(await reader.readToday()).toEqual({ ok: true, events: [] });
    await reader.readToday();
    expect(outlook.readToday).toHaveBeenCalledTimes(1);
    expect(agent.readToday).toHaveBeenCalledTimes(2);
  });
});
