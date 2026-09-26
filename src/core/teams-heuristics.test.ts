import { describe, expect, it } from "vitest";
import { isMeetingTitle, micInUseKeys, parseTasklistCsv, teamsInMeeting } from "./teams-heuristics";

const TASKLIST = [
  '"ms-teams.exe","14200","Console","1","312,400 K","Running","PC\\alice","0:01:12","Chat | Acme | Microsoft Teams"',
  '"ms-teams.exe","14888","Console","1","98,100 K","Running","PC\\alice","0:00:20","Meeting with Bob ""Q4"" | Microsoft Teams"',
  '"ms-teams.exe","15010","Console","1","40,000 K","Unknown","PC\\alice","0:00:01","N/A"',
].join("\r\n");

const REG = [
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\MSTeams_8wekyb3d8bbwe",
  "    Value    REG_SZ    Allow",
  "    LastUsedTimeStart    REG_QWORD    0x1db0f2a9c3d4e5f",
  "    LastUsedTimeStop    REG_QWORD    0x0",
  "",
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\C:#Program Files#Zoom#Zoom.exe",
  "    LastUsedTimeStart    REG_QWORD    0x1db0f2a9c3d4e5f",
  "    LastUsedTimeStop    REG_QWORD    0x1db0f2b0c3d4e5f",
].join("\r\n");

describe("parseTasklistCsv", () => {
  it("reads image, pid and window title, unescaping quotes", () => {
    const rows = parseTasklistCsv(TASKLIST);
    expect(rows.map((row) => row.title)).toEqual(["Chat | Acme | Microsoft Teams", 'Meeting with Bob "Q4" | Microsoft Teams', "N/A"]);
    expect(rows[1]).toMatchObject({ image: "ms-teams.exe", pid: 14888 });
    expect(parseTasklistCsv("INFO: No tasks are running which match the specified criteria.")).toEqual([]);
  });
});

describe("isMeetingTitle", () => {
  it("matches call and meeting windows but not Teams' own tabs", () => {
    expect(isMeetingTitle("Meeting with Bob | Microsoft Teams")).toBe(true);
    expect(isMeetingTitle("Call with Alice | Microsoft Teams")).toBe(true);
    expect(isMeetingTitle("Meet now | Microsoft Teams")).toBe(true);
    expect(isMeetingTitle("Calls | Microsoft Teams")).toBe(false);
    expect(isMeetingTitle("Calendar | Microsoft Teams")).toBe(false);
    expect(isMeetingTitle("Chat | Acme | Microsoft Teams")).toBe(false);
    expect(isMeetingTitle("N/A")).toBe(false);
  });
});

describe("micInUseKeys", () => {
  it("returns apps with the mic open now (stop time 0x0)", () => {
    expect(micInUseKeys(REG)).toEqual([expect.stringMatching(/MSTeams_8wekyb3d8bbwe$/)]);
  });
});

describe("teamsInMeeting", () => {
  const chatOnly = parseTasklistCsv(TASKLIST.split("\r\n")[0] ?? "");
  it("needs Teams running, plus the mic or a meeting window", () => {
    expect(teamsInMeeting({ windows: parseTasklistCsv(TASKLIST), micKeys: [] })).toBe(true);
    expect(teamsInMeeting({ windows: chatOnly, micKeys: micInUseKeys(REG) })).toBe(true);
    expect(teamsInMeeting({ windows: chatOnly, micKeys: [] })).toBe(false);
    expect(teamsInMeeting({ windows: [], micKeys: micInUseKeys(REG) })).toBe(false);
  });
});
