import { afterEach, describe, expect, it, vi } from "vitest";
import type { CalendarReader } from "../core/calendar";
import type { MeetingContextSettings } from "../core/meeting-context";
import type { BriefingView } from "../shared/ipc";
import { createBriefingWatcher } from "./briefing-watcher";

const calendar: CalendarReader = {
  readToday: async () => ({
    ok: true,
    events: [{ subject: "Weekly sync", start: "2026-11-06T14:00:00.000Z", end: "2026-11-06T14:30:00.000Z", organizer: "Sam Lee", required: ["Priya Shah"], optional: [], location: "", body: "" }],
  }),
};

function setup(settings: MeetingContextSettings) {
  const sent: BriefingView[] = [];
  const watcher = createBriefingWatcher({ calendar, records: () => [], settings: () => settings, send: (view) => void sent.push(view), now: () => Date.parse("2026-11-06T13:59:00Z") });
  return { watcher, sent };
}

describe("createBriefingWatcher", () => {
  let stop: () => void = () => undefined;
  afterEach(() => stop());

  it("sends each meeting's briefing once and keeps it for Dig deeper", async () => {
    const { watcher, sent } = setup({ enabled: true, calendar: true, memory: true });
    stop = watcher.stop;
    await watcher.tick();
    await watcher.tick();
    expect(sent).toEqual([{ key: "Weekly sync@2026-11-06T14:00:00.000Z", lines: ["In 1 min: Weekly sync with Priya Shah", "Nothing saved from earlier meetings with them."] }]);
    expect(watcher.get(sent[0]?.key ?? "")?.subject).toBe("Weekly sync");
  });

  it("stays quiet with meeting context or the calendar switched off", async () => {
    for (const settings of [{ enabled: false, calendar: true, memory: true }, { enabled: true, calendar: false, memory: true }]) {
      const { watcher, sent } = setup(settings);
      await watcher.tick();
      watcher.stop();
      expect(sent).toEqual([]);
    }
  });
});
