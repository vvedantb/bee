import { describe, expect, it } from "vitest";
import { currentTeamsTitle, isTeamsMeetingRow, parseTeamsTitle, parseWindowNameLines, parseWindowTitleJson } from "./teams-title";

describe("parseTeamsTitle", () => {
  it("reads the name from new Teams titles", () => {
    expect(parseTeamsTitle("Weekly Sync | Microsoft Teams")).toMatchObject({ name: "Weekly Sync", view: "meeting", generic: false });
    expect(parseTeamsTitle("Meeting with Bob | Microsoft Teams")).toMatchObject({ name: "Meeting with Bob", person: "Bob", generic: false });
    expect(parseTeamsTitle("Call with Alice | Microsoft Teams")).toMatchObject({ name: "Call with Alice", person: "Alice" });
  });

  it("marks a meeting chat tab as a chat view", () => {
    expect(parseTeamsTitle("Weekly Sync | Chat | Microsoft Teams")).toMatchObject({ name: "Weekly Sync", view: "chat" });
  });

  it("calls Meet now generic, so it never matches a calendar subject by name", () => {
    expect(parseTeamsTitle("Meet now | Microsoft Teams")).toMatchObject({ name: "Meet now", generic: true });
  });

  it("reads classic variants with a dash or a suffix in brackets", () => {
    expect(parseTeamsTitle("Weekly Sync – Microsoft Teams")?.name).toBe("Weekly Sync");
    expect(parseTeamsTitle("Weekly Sync - Microsoft Teams")?.name).toBe("Weekly Sync");
    expect(parseTeamsTitle("Weekly Sync | Microsoft Teams classic")?.name).toBe("Weekly Sync");
    expect(parseTeamsTitle("Weekly Sync | Microsoft Teams (work or school)")?.name).toBe("Weekly Sync");
    expect(parseTeamsTitle("Q3 - planning | Microsoft Teams")?.name).toBe("Q3 - planning");
  });

  it("ignores tab titles, the bare app title and empty titles", () => {
    for (const title of ["Chat | Alice | Microsoft Teams", "Calendar | Microsoft Teams", "Calls | Microsoft Teams", "Activity | Microsoft Teams", "Microsoft Teams", "", "N/A", "  "]) {
      expect(parseTeamsTitle(title), title).toBeNull();
    }
  });
});

describe("currentTeamsTitle", () => {
  const rows = [
    { image: "ms-teams.exe", title: "Chat | Alice | Microsoft Teams" },
    { image: "ms-teams.exe", title: "Weekly Sync | Chat | Microsoft Teams" },
    { image: "teams.exe", title: "Weekly Sync | Microsoft Teams" },
    { image: "chrome.exe", title: "Budget call | Google Chrome" },
  ];

  it("prefers the meeting window over its chat tab, and ignores other apps", () => {
    expect(currentTeamsTitle(rows, true)).toMatchObject({ name: "Weekly Sync", view: "meeting" });
  });

  it("prefers a named meeting over a generic one", () => {
    expect(
      currentTeamsTitle([{ image: "ms-teams.exe", title: "Meet now | Microsoft Teams" }, { image: "ms-teams.exe", title: "Weekly Sync | Microsoft Teams" }], true)?.name,
    ).toBe("Weekly Sync");
  });

  it("outside a call only accepts titles that read like a call", () => {
    expect(currentTeamsTitle(rows, false)).toBeNull();
    expect(currentTeamsTitle([{ image: "ms-teams.exe", title: "Call with Alice | Microsoft Teams" }], false)?.name).toBe("Call with Alice");
  });

  it("returns null with no Teams window", () => {
    expect(currentTeamsTitle([], true)).toBeNull();
  });

  it("isTeamsMeetingRow needs a Teams image and a call-like title", () => {
    expect(isTeamsMeetingRow({ image: "ms-teams.exe", title: "Meeting with Bob | Microsoft Teams" })).toBe(true);
    expect(isTeamsMeetingRow({ image: "ms-teams.exe", title: "Weekly Sync | Microsoft Teams" })).toBe(false);
    expect(isTeamsMeetingRow({ image: "chrome.exe", title: "Meeting with Bob" })).toBe(false);
  });
});

describe("window reader output", () => {
  it("parses one object, an array, and nothing", () => {
    expect(parseWindowTitleJson('{"image":"ms-teams.exe","title":"A | Microsoft Teams"}')).toEqual([{ image: "ms-teams.exe", title: "A | Microsoft Teams" }]);
    expect(parseWindowTitleJson('[{"image":"a.exe","title":"x"},{"image":"b.exe","title":""},5]')).toEqual([{ image: "a.exe", title: "x" }]);
    expect(parseWindowTitleJson("")).toEqual([]);
    expect(parseWindowTitleJson("not json")).toEqual([]);
  });

  it("parses one macOS window name per line", () => {
    expect(parseWindowNameLines("Weekly Sync | Microsoft Teams\n\n Chat | Microsoft Teams \n").map((row) => row.title)).toEqual([
      "Weekly Sync | Microsoft Teams",
      "Chat | Microsoft Teams",
    ]);
  });
});
