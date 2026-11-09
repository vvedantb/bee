import { describe, expect, it } from "vitest";
import { isZoomCallTitle, parseMeetTitle } from "./agent-desktop-meeting";
import { qualifies } from "./auto-meeting-detection";
import { NO_SIGNALS, mergeSignals, readerSignals, windowsSignals } from "./meeting-signals";
import { isMeetingTitle, micAppKind, micInUseKeys, parseTasklistCsv } from "./teams-heuristics";

const MIC = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone";
const LIVE = ["    LastUsedTimeStart    REG_QWORD    0x1db0f2a9c3d4e5f", "    LastUsedTimeStop    REG_QWORD    0x0"];
const DONE = ["    LastUsedTimeStart    REG_QWORD    0x1db0f2a9c3d4e5f", "    LastUsedTimeStop    REG_QWORD    0x1db0f2b0c3d4e5f"];
const reg = (...blocks: Array<[string, string[]]>) => blocks.flatMap(([key, values]) => [`${MIC}\\${key}`, "    Value    REG_SZ    Allow", ...values, ""]).join("\r\n");

const row = (image: string, title: string) => `"${image}","100","Console","1","90,000 K","Running","PC\\alice","0:00:10","${title}"`;
const rows = (...items: Array<[string, string]>) => parseTasklistCsv(items.map(([image, title]) => row(image, title)).join("\r\n"));

describe("micInUseKeys fixtures", () => {
  it("finds packaged, NonPackaged and browser keys with stop time 0x0", () => {
    const text = reg(
      ["MSTeams_8wekyb3d8bbwe", LIVE],
      ["NonPackaged\\C:#Users#alice#AppData#Roaming#Zoom#bin#Zoom.exe", LIVE],
      ["NonPackaged\\C:#Program Files#Google#Chrome#Application#chrome.exe", LIVE],
      ["NonPackaged\\C:#Users#alice#AppData#Local#Spotify#Spotify.exe", LIVE],
      ["NonPackaged\\C:#Program Files#Old#Skype.exe", DONE],
    );
    const keys = micInUseKeys(text);
    expect(keys).toHaveLength(4);
    expect(keys.map(micAppKind)).toEqual(["teams", "zoom", "browser", null]);
  });

  it("ignores keys never used (start 0x0), the parent heading and empty output", () => {
    const never = ["    LastUsedTimeStart    REG_QWORD    0x0", "    LastUsedTimeStop    REG_QWORD    0x0"];
    expect(micInUseKeys(reg(["MSTeams_8wekyb3d8bbwe", never]))).toEqual([]);
    expect(micInUseKeys(`${MIC}\r\n    Value    REG_SZ    Allow\r\n`)).toEqual([]);
    expect(micInUseKeys("")).toEqual([]);
    expect(micInUseKeys("ERROR: The system was unable to find the specified registry key or value.")).toEqual([]);
  });

  it("keeps the last key when the output has no trailing blank line", () => {
    expect(micInUseKeys(`${MIC}\\MSTeams_8wekyb3d8bbwe\r\n${LIVE.join("\r\n")}`)).toHaveLength(1);
  });
});

describe("micAppKind", () => {
  it("names meeting apps and leaves the rest null", () => {
    const key = (name: string) => `${MIC}\\NonPackaged\\${name}`;
    expect(micAppKind(`${MIC}\\MSTeams_8wekyb3d8bbwe`)).toBe("teams");
    expect(micAppKind(key("C:#Users#a#AppData#Local#Microsoft#Teams#current#Teams.exe"))).toBe("teams");
    expect(micAppKind(key("C:#Program Files#WindowsApps#MSTeams#ms-teams.exe"))).toBe("teams");
    expect(micAppKind(key("C:#Users#a#AppData#Roaming#Zoom#bin#Zoom.exe"))).toBe("zoom");
    expect(micAppKind(key("C:#Program Files (x86)#Microsoft#Edge#Application#msedge.exe"))).toBe("browser");
    expect(micAppKind(key("C:#Program Files#Mozilla Firefox#firefox.exe"))).toBe("browser");
    expect(micAppKind(key("C:#Users#a#AppData#Local#Spotify#Spotify.exe"))).toBeNull();
    expect(micAppKind(key("C:#Program Files#VideoLAN#VLC#vlc.exe"))).toBeNull();
    expect(micAppKind(key("C:#Tools#NotTeams.exe"))).toBeNull();
    expect(micAppKind(`${MIC}\\Microsoft.WindowsCamera_8wekyb3d8bbwe`)).toBeNull();
  });
});

describe("in-call title fixtures", () => {
  it("Teams: calls and meetings yes; chat, home, calendar and badges no", () => {
    for (const title of ["Meeting with Bob | Microsoft Teams", "Call with Alice | Microsoft Teams", "Weekly sync meeting | Microsoft Teams", "Meet now | Microsoft Teams", "(2) Call with Alice | Microsoft Teams"]) {
      expect(isMeetingTitle(title), title).toBe(true);
    }
    for (const title of ["Chat | Acme | Microsoft Teams", "(3) Chat | Alice | Microsoft Teams", "Home | Microsoft Teams", "Calendar | Microsoft Teams", "Calls | Microsoft Teams", "Meetings | Microsoft Teams", "Activity | Microsoft Teams", "Files | Microsoft Teams", "Microsoft Teams", "N/A", ""]) {
      expect(isMeetingTitle(title), title).toBe(false);
    }
  });

  it("Zoom: the call window and roster yes; the home window no", () => {
    for (const title of ["Zoom Meeting", "Zoom Meeting 40-Minutes", "Zoom Webinar", "Participants (4)"]) expect(isZoomCallTitle(title), title).toBe(true);
    for (const title of ["Zoom", "Zoom Workplace", "Home - Zoom", "Settings", ""]) expect(isZoomCallTitle(title), title).toBe(false);
  });

  it("Google Meet: a coded tab yes; the landing page, an ended call and other tabs no", () => {
    expect(parseMeetTitle("Meet - abc-defg-hij - Google Chrome")).toEqual({ name: "abc-defg-hij", generic: true });
    expect(parseMeetTitle("Weekly sync - Google Meet - Microsoft Edge")?.name).toBe("Weekly sync");
    for (const title of ["Google Meet - Google Chrome", "Meet - Google Chrome", "Meeting ended - Google Chrome", "Inbox (3) - alice@example.com - Gmail - Google Chrome", "Spotify - Web Player - Google Chrome"]) {
      expect(parseMeetTitle(title), title).toBeNull();
    }
  });
});

describe("windowsSignals", () => {
  const teamsKey = `${MIC}\\MSTeams_8wekyb3d8bbwe`;
  const zoomKey = `${MIC}\\NonPackaged\\C:#Zoom#bin#Zoom.exe`;
  const spotifyKey = `${MIC}\\NonPackaged\\C:#Spotify#Spotify.exe`;
  const chromeKey = `${MIC}\\NonPackaged\\C:#Chrome#chrome.exe`;

  it("Teams call: present, in-call title, mic, and the meeting as identity", () => {
    const signals = windowsSignals({ windows: rows(["ms-teams.exe", "Meeting with Bob | Microsoft Teams"]), micKeys: [teamsKey] });
    expect(signals).toEqual({ meetingAppPresent: true, inCallTitle: true, micInUseByMeetingApp: true, identity: "meeting with bob" });
    expect(qualifies(signals)).toBe(true);
  });

  it("chat-only Teams does not qualify, even with the window open", () => {
    const signals = windowsSignals({ windows: rows(["ms-teams.exe", "Chat | Acme | Microsoft Teams"]), micKeys: [] });
    expect(signals).toMatchObject({ meetingAppPresent: true, inCallTitle: false, micInUseByMeetingApp: false });
    expect(qualifies(signals)).toBe(false);
  });

  it("a music app with the mic does not qualify, with or without Teams chat open", () => {
    expect(qualifies(windowsSignals({ windows: [], micKeys: [spotifyKey] }))).toBe(false);
    const chat = windowsSignals({ windows: rows(["ms-teams.exe", "Chat | Acme | Microsoft Teams"]), micKeys: [spotifyKey] });
    expect(chat.micInUseByMeetingApp).toBe(false);
    expect(qualifies(chat)).toBe(false);
  });

  it("Teams mic with the call window closed still qualifies (leaving the window)", () => {
    const signals = windowsSignals({ windows: rows(["ms-teams.exe", "Chat | Acme | Microsoft Teams"]), micKeys: [teamsKey] });
    expect(signals).toMatchObject({ meetingAppPresent: true, inCallTitle: false, micInUseByMeetingApp: true });
    expect(qualifies(signals)).toBe(true);
  });

  it("a plain browser holding the mic is not a meeting; a Meet tab is", () => {
    const plain = windowsSignals({ windows: rows(["chrome.exe", "Spotify - Web Player - Google Chrome"]), micKeys: [chromeKey] });
    expect(plain.meetingAppPresent).toBe(false);
    expect(qualifies(plain)).toBe(false);
    const meet = windowsSignals({ windows: rows(["chrome.exe", "Meet - abc-defg-hij - Google Chrome"]), micKeys: [chromeKey] });
    expect(meet).toEqual({ meetingAppPresent: true, inCallTitle: true, micInUseByMeetingApp: true, identity: "google meet abc-defg-hij" });
  });

  it("Zoom: the process is always there, so the home window alone does not qualify", () => {
    expect(qualifies(windowsSignals({ windows: rows(["Zoom.exe", "Zoom Workplace"]), micKeys: [] }))).toBe(false);
    const call = windowsSignals({ windows: rows(["Zoom.exe", "Zoom Meeting"]), micKeys: [zoomKey] });
    expect(call).toMatchObject({ inCallTitle: true, micInUseByMeetingApp: true, identity: "zoom meeting" });
  });

  it("Zoom mic key without a Zoom process is stale and ignored", () => {
    expect(windowsSignals({ windows: [], micKeys: [zoomKey] })).toEqual({ ...NO_SIGNALS });
  });
});

describe("readerSignals and mergeSignals", () => {
  it("turns a reader call window into title signals, and nothing into none", () => {
    const meeting = { key: "zoom meeting", title: "Zoom Meeting", label: "Zoom meeting" };
    expect(readerSignals({ inMeeting: true, source: "windows", meetings: [meeting] })).toEqual({ meetingAppPresent: true, inCallTitle: true, micInUseByMeetingApp: false, identity: "zoom meeting" });
    expect(readerSignals({ inMeeting: false, source: "none", meetings: [] })).toEqual(NO_SIGNALS);
    expect(readerSignals(null)).toEqual(NO_SIGNALS);
  });

  it("merges with OR and keeps the first known identity", () => {
    const a = { meetingAppPresent: true, inCallTitle: false, micInUseByMeetingApp: true, identity: null };
    const b = { meetingAppPresent: true, inCallTitle: true, micInUseByMeetingApp: false, identity: "x" };
    expect(mergeSignals(a, b)).toEqual({ meetingAppPresent: true, inCallTitle: true, micInUseByMeetingApp: true, identity: "x" });
    expect(mergeSignals(NO_SIGNALS, NO_SIGNALS)).toEqual(NO_SIGNALS);
  });
});
