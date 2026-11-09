import { describe, expect, it } from "vitest";
import { qualifies } from "../core/auto-meeting-detection";
import { createMeetingSignals } from "./meeting-signals";

// Windows only: tasklist and reg do not exist on the test host, so they read as nothing and the PowerShell titles are all there is.
// That is the packaged-app case: tasklist has no title, the PowerShell reader does.
const noReader = { read: async () => null };

describe("createMeetingSignals: PowerShell titles on Windows", () => {
  it("reads an in-call compact title from the title reader (muted, no mic)", async () => {
    const titles = { read: async () => [{ image: "ms-teams.exe", title: "Weekly Sync | Microsoft Teams" }] };
    const signals = await createMeetingSignals({ reader: noReader, titles, platform: "win32" }).read();
    expect(signals).toMatchObject({ meetingAppPresent: true, inCallTitle: true, titleClass: "incall", identity: "weekly sync" });
    expect(qualifies(signals)).toBe(true);
  });

  it("reads the pre-join title as pre-join, not as a call", async () => {
    const titles = { read: async () => [{ image: "ms-teams.exe", title: "Meeting join | PD | Microsoft Teams" }] };
    const signals = await createMeetingSignals({ reader: noReader, titles, platform: "win32" }).read();
    expect(signals).toMatchObject({ meetingAppPresent: true, inCallTitle: false, preJoinTitle: true, titleClass: "prejoin" });
    expect(qualifies(signals)).toBe(false);
  });

  it("fails open when the title reader throws", async () => {
    const titles = { read: async () => Promise.reject(new Error("powershell failed")) };
    const signals = await createMeetingSignals({ reader: noReader, titles, platform: "win32" }).read();
    expect(signals).toMatchObject({ meetingAppPresent: false, inCallTitle: false });
  });

  it("does not read titles on Linux", async () => {
    let called = false;
    const titles = { read: async () => ((called = true), []) };
    const signals = await createMeetingSignals({ reader: noReader, titles, platform: "linux" }).read();
    expect(called).toBe(false);
    expect(signals.meetingAppPresent).toBe(false);
  });
});
