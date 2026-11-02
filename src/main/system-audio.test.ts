import { describe, expect, it } from "vitest";
import { findTeamsWindowSource, isPermissionAllowed, pickTeamsWindowSource } from "./system-audio";

describe("isPermissionAllowed", () => {
  it("allows the mic only: screen capture is denied, so getDisplayMedia can never take all system audio", () => {
    expect(isPermissionAllowed("media")).toBe(true);
    for (const other of ["display-capture", "geolocation", "notifications", "clipboard-read", "openExternal"]) expect(isPermissionAllowed(other)).toBe(false);
  });
});

describe("pickTeamsWindowSource", () => {
  it("prefers the call window over other Teams windows, whatever the order", () => {
    const sources = [
      { id: "window:1:0", name: "Microsoft Teams" },
      { id: "window:2:0", name: "Chat | Microsoft Teams" },
      { id: "window:3:0", name: "Weekly Sync | Chat | Microsoft Teams" },
      { id: "window:4:0", name: "Weekly Sync | Microsoft Teams" },
      { id: "window:5:0", name: "Meeting with Alice | Microsoft Teams" },
    ];
    expect(pickTeamsWindowSource(sources)).toBe("window:5:0");
    expect(pickTeamsWindowSource([...sources].reverse())).toBe("window:5:0");
  });

  it("falls back to a named meeting, then a meeting chat, then the main window", () => {
    expect(pickTeamsWindowSource([{ id: "window:1:0", name: "Microsoft Teams" }, { id: "window:4:0", name: "Weekly Sync | Microsoft Teams" }])).toBe("window:4:0");
    expect(pickTeamsWindowSource([{ id: "window:1:0", name: "Calendar | Microsoft Teams" }, { id: "window:3:0", name: "Weekly Sync | Chat | Microsoft Teams" }])).toBe("window:3:0");
    expect(pickTeamsWindowSource([{ id: "window:1:0", name: "Microsoft Teams (work or school)" }])).toBe("window:1:0");
    expect(pickTeamsWindowSource([{ id: "window:9:0", name: "Meeting | Microsoft Teams classic" }])).toBe("window:9:0");
  });

  it("never picks a screen or another app, even one that mentions Teams", () => {
    expect(pickTeamsWindowSource([{ id: "screen:0:0", name: "Meeting with Alice | Microsoft Teams" }])).toBeNull();
    expect(
      pickTeamsWindowSource([
        { id: "window:1:0", name: "Zoom Meeting" },
        { id: "window:2:0", name: "Microsoft Teams pricing - Google Chrome" },
        { id: "window:3:0", name: "Notes about Microsoft Teams.txt - Notepad" },
        { id: "window:4:0", name: "| Microsoft Teams" },
      ]),
    ).toBeNull();
    expect(pickTeamsWindowSource([])).toBeNull();
  });
});

describe("findTeamsWindowSource", () => {
  it("asks for windows only, with no thumbnails or icons", async () => {
    const asked: unknown[] = [];
    const id = await findTeamsWindowSource(async (options) => {
      asked.push(options);
      return [{ id: "window:7:0", name: "Meeting with Bob | Microsoft Teams" }];
    });
    expect(id).toBe("window:7:0");
    expect(asked).toEqual([{ types: ["window"], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false }]);
  });

  it("degrades to null when the capturer throws or Teams has no window", async () => {
    expect(await findTeamsWindowSource(async () => { throw new Error("denied"); })).toBeNull();
    expect(await findTeamsWindowSource(async () => [{ id: "window:1:0", name: "Inbox - Outlook" }])).toBeNull();
  });
});
