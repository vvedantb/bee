import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseApps, parseEnvelope, parseSnapshotTree, parseWindows } from "./agent-desktop-envelope";
import {
  EMPTY_CAPTIONS,
  appKind,
  captionKey,
  captionStep,
  detectMeetings,
  echoesOwnLine,
  extractCaptionLines,
  extractParticipants,
  isPossibleTeamsCall,
  isZoomCallTitle,
  meetingReading,
  meetingTerms,
  meetingWindowBrief,
  mergeReadings,
  parseMeetTitle,
  personName,
  type CaptionLine,
  type CaptionMemory,
} from "./agent-desktop-meeting";

const data = (name: string) => {
  const result = parseEnvelope(readFileSync(new URL(`../../test/fixtures/agent-desktop/${name}`, import.meta.url), "utf8"));
  if (!result.ok) throw new Error(`fixture ${name} is an error envelope`);
  return result.data;
};
const tree = (name: string) => parseSnapshotTree(data(name));

describe("appKind", () => {
  it("knows Teams, Zoom and the browsers by name on macOS and Windows", () => {
    for (const name of ["Microsoft Teams", "Microsoft Teams classic", "MSTeams", "ms-teams", "ms-teams.exe", "Teams.exe"]) expect(appKind(name), name).toBe("teams");
    for (const name of ["zoom.us", "Zoom", "Zoom.exe", "Zoom Workplace"]) expect(appKind(name), name).toBe("zoom");
    for (const name of ["Google Chrome", "chrome.exe", "Microsoft​ Edge", "msedge", "Arc", "Safari", "Firefox", "Brave Browser"]) expect(appKind(name), name).toBe("browser");
    for (const name of ["ZoomIt", "Finder", "Slack", "Teamspeak"]) expect(appKind(name), name).toBeNull();
  });

  it("falls back to the bundle id", () => {
    expect(appKind("Besprechung", "com.microsoft.teams2")).toBe("teams");
    expect(appKind("Something", "us.zoom.xos")).toBe("zoom");
    expect(appKind("Navigateur", "com.google.Chrome")).toBe("browser");
  });
});

describe("parseMeetTitle", () => {
  it("reads the meeting from a Meet tab title in each browser", () => {
    expect(parseMeetTitle("Meet - abc-defg-hij - Google Chrome")).toEqual({ name: "abc-defg-hij", generic: true });
    expect(parseMeetTitle("Meet - abc-defg-hij - Google Chrome - Work")).toEqual({ name: "abc-defg-hij", generic: true });
    expect(parseMeetTitle("Meet – Acme renewal — Mozilla Firefox")).toEqual({ name: "Acme renewal", generic: false });
    expect(parseMeetTitle("Meet - Acme renewal and 2 more pages - Work - Microsoft​ Edge")).toEqual({ name: "Acme renewal", generic: false });
    expect(parseMeetTitle("Meet - Weekly sync")).toEqual({ name: "Weekly sync", generic: false });
    expect(parseMeetTitle("Weekly sync - Google Meet")).toEqual({ name: "Weekly sync", generic: false });
  });

  it("ignores the Meet home page and other tabs", () => {
    for (const title of ["Google Meet - Google Chrome", "Google Meet", "Meet", "Meet - Google Meet", "Inbox (3) - Gmail - Google Chrome", "Meeting notes - Google Docs - Google Chrome", ""]) {
      expect(parseMeetTitle(title), title).toBeNull();
    }
  });
});

describe("isZoomCallTitle", () => {
  it("knows the call window and its roster, not the home window", () => {
    for (const title of ["Zoom Meeting", "Zoom Meeting 40-Minutes", "Zoom Webinar", "Participants (4)"]) expect(isZoomCallTitle(title), title).toBe(true);
    for (const title of ["Zoom Workplace", "Zoom", "Home", "Zoom - Free Account", "Settings"]) expect(isZoomCallTitle(title), title).toBe(false);
  });
});

describe("detectMeetings", () => {
  it("finds the Zoom call and the Meet tab on macOS, focused first", () => {
    const meetings = detectMeetings({ windows: parseWindows(data("list-windows-mac.json")), apps: parseApps(data("list-apps-mac.json")) });
    expect(meetings.map(({ app, windowId, name }) => ({ app, windowId, name }))).toEqual([
      { app: "zoom", windowId: "w-2002", name: null },
      { app: "meet", windowId: "w-3001", name: null },
    ]);
  });

  it("counts a Teams window with a plain meeting name only once a light check confirmed it", () => {
    const windows = parseWindows(data("list-windows-mac.json"));
    expect(windows.filter(isPossibleTeamsCall).map((window) => window.id)).toEqual(["w-1002"]);
    const meetings = detectMeetings({ windows, confirmed: new Set(["w-1002"]) });
    expect(meetings.find((meeting) => meeting.app === "teams")).toMatchObject({ windowId: "w-1002", name: "Acme renewal", appName: "Microsoft Teams" });
  });

  it("finds Teams, Zoom and an Edge Meet tab on Windows, and skips tabs and the Meet home page", () => {
    const meetings = detectMeetings({ windows: parseWindows(data("list-windows-win.json")) });
    expect(meetings.map(({ app, name }) => ({ app, name }))).toEqual([
      { app: "teams", name: "Meeting with Bob Jones" },
      { app: "zoom", name: null },
      { app: "meet", name: "Acme renewal" },
    ]);
  });

  it("finds nothing when no call window is open", () => {
    expect(detectMeetings({ windows: parseWindows(data("list-windows-idle.json")) })).toEqual([]);
    expect(meetingReading([])).toEqual({ inMeeting: false, source: "none", meetings: [] });
  });
});

describe("meetingReading and mergeReadings", () => {
  it("names one candidate per meeting, Teams keys matching the built-in detector", () => {
    const reading = meetingReading(detectMeetings({ windows: parseWindows(data("list-windows-win.json")) }));
    expect(reading.inMeeting).toBe(true);
    expect(reading.meetings).toEqual([
      { key: "meeting with bob jones", title: "Meeting with Bob Jones | Microsoft Teams", label: "Meeting with Bob Jones" },
      { key: "zoom meeting", title: "Zoom Meeting 40-Minutes", label: "Zoom meeting" },
      { key: "google meet acme renewal", title: "Meet - Acme renewal and 2 more pages - Work - Microsoft​ Edge", label: "Google Meet: Acme renewal" },
    ]);
  });

  it("merges with the built-in reading: either says in a meeting, each meeting once", () => {
    const own = { inMeeting: true, source: "windows" as const, meetings: [{ key: "meeting with bob jones", title: "Meeting with Bob Jones | Microsoft Teams", label: "Meeting with Bob Jones" }] };
    const extra = meetingReading(detectMeetings({ windows: parseWindows(data("list-windows-win.json")) }));
    const merged = mergeReadings(own, extra);
    expect(merged.inMeeting).toBe(true);
    expect(merged.meetings.map((meeting) => meeting.key)).toEqual(["meeting with bob jones", "zoom meeting", "google meet acme renewal"]);
    expect(mergeReadings({ inMeeting: false, source: "none", meetings: [] }, { inMeeting: false, source: "none", meetings: [] }).inMeeting).toBe(false);
    expect(mergeReadings({ inMeeting: true, source: "windows", meetings: [] }, { inMeeting: false, source: "none", meetings: [] }).inMeeting).toBe(true);
  });
});

describe("personName", () => {
  it("cleans roster rows and tile labels", () => {
    expect(personName("Priya Patel, Organizer, Muted")).toBe("Priya Patel");
    expect(personName("Dana Wu (Host, me)")).toBe("Dana Wu");
    expect(personName("Bob Jones (Guest)")).toBe("Bob Jones");
    expect(personName("Fatima Khan, Computer audio muted")).toBe("Fatima Khan");
    expect(personName("Siobhán O’Neill-Smyth")).toBe("Siobhán O’Neill-Smyth");
  });

  it("rejects headers, controls and anything that is not a name", () => {
    for (const text of ["In this meeting (3)", "Invited (1)", "Mute all", "Participants", "Raise hand", "", "x", "Room 4.12", "A very long label with far too many words in it"]) {
      expect(personName(text), text).toBeNull();
    }
  });
});

describe("extractParticipants", () => {
  it("reads the Teams roster, without headers or duplicates", () => {
    expect(extractParticipants(tree("snapshot-teams-captions.json"))).toEqual(["Priya Patel", "Bob Jones", "Sam Lee"]);
  });

  it("reads the Zoom participants list", () => {
    expect(extractParticipants(tree("snapshot-zoom-captions.json"))).toEqual(["Dana Wu", "Eli Brown", "Fatima Khan"]);
  });

  it("finds nobody when the roster is closed (video tiles and buttons do not count)", () => {
    expect(extractParticipants(tree("snapshot-teams-no-captions.json"))).toEqual([]);
    expect(extractParticipants(null)).toEqual([]);
  });
});

describe("extractCaptionLines", () => {
  it("reads Teams caption rows as speaker and words", () => {
    expect(extractCaptionLines(tree("snapshot-teams-captions.json"))).toEqual({
      visible: true,
      lines: [
        { speaker: "Priya Patel", text: "Let's pick up the Acme renewal." },
        { speaker: "Bob Jones", text: "They want twenty percent off if they sign this week." },
        { speaker: "Priya Patel", text: "When does SSO ship for enterprise" },
      ],
    });
  });

  it("reads Zoom's inline \"Name: words\" captions", () => {
    expect(extractCaptionLines(tree("snapshot-zoom-captions.json")).lines).toEqual([
      { speaker: "Eli Brown", text: "Can we confirm the SSO date?" },
      { speaker: "Dana Wu", text: "SSO ships in March." },
    ]);
  });

  it("is not fooled by caption menu items, buttons or a settings group", () => {
    expect(extractCaptionLines(tree("snapshot-teams-no-captions.json"))).toEqual({ visible: false, lines: [] });
  });

  it("keeps spoken words that sound like controls, and drops buttons inside the region", () => {
    const leaf = (role: string, name: string) => ({ role, name, value: "", description: "", children: [] });
    const region = {
      role: "group",
      name: "Captions",
      value: "",
      description: "",
      children: [leaf("text", "Can you show the slide?"), leaf("text", "Let's start with more detail."), leaf("button", "Close captions"), leaf("button", "Settings")],
    };
    const root = { role: "window", name: "Zoom Meeting", value: "", description: "", children: [region] };
    expect(extractCaptionLines(root).lines.map((line) => line.text)).toEqual(["Can you show the slide?", "Let's start with more detail."]);
  });

  it("never treats the window itself as a caption region", () => {
    const window = { role: "window", name: "Transcript review | Microsoft Teams", value: "", description: "", children: [{ role: "text", name: "Hello", value: "", description: "", children: [] }] };
    expect(extractCaptionLines(window).visible).toBe(false);
  });

  it("does not take lowercase caption text for a speaker", () => {
    const row = (texts: string[]) => ({ role: "listitem", name: "", value: "", description: "", children: texts.map((name) => ({ role: "text", name, value: "", description: "", children: [] })) });
    const region = { role: "group", name: "Live captions", value: "", description: "", children: [row(["So the renewal", "is next week."]), row(["Eli Brown", "10:02", "Agreed."])] };
    const root = { role: "window", name: "Zoom Meeting", value: "", description: "", children: [region] };
    expect(extractCaptionLines(root).lines).toEqual([
      { speaker: null, text: "So the renewal" },
      { speaker: null, text: "is next week." },
      { speaker: "Eli Brown", text: "Agreed." },
    ]);
  });
});

describe("captionStep", () => {
  const line = (text: string, speaker: string | null = "Bob Jones"): CaptionLine => ({ speaker, text });
  const step = (memory: CaptionMemory, lines: CaptionLine[], now = 0) => captionStep(memory, lines, now);

  it("treats what the window shows at first as history", () => {
    const first = step(EMPTY_CAPTIONS, [line("Hello all."), line("Let's start.")]);
    expect(first.fresh).toEqual([]);
    expect(first.memory.primed).toBe(true);
    expect(step(first.memory, [line("Hello all."), line("Let's start.")], 1500).fresh).toEqual([]);
  });

  it("sends a line once a newer line follows it, or once it stops changing", () => {
    let memory = step(EMPTY_CAPTIONS, [line("Hello all.")]).memory;
    let next = step(memory, [line("Hello all."), line("When does SSO")], 1500);
    expect(next.fresh).toEqual([]);
    memory = next.memory;
    next = step(memory, [line("Hello all."), line("When does SSO ship?")], 3000);
    expect(next.fresh).toEqual([]);
    memory = next.memory;
    next = step(memory, [line("Hello all."), line("When does SSO ship?")], 4500);
    expect(next.fresh).toEqual([line("When does SSO ship?")]);
    memory = next.memory;
    next = step(memory, [line("When does SSO ship?"), line("Next item", "Priya Patel")], 6000);
    expect(next.fresh).toEqual([]);
  });

  it("sends only the words a sent line gained", () => {
    let memory = step(EMPTY_CAPTIONS, []).memory;
    memory = step(memory, [line("So the renewal is next week.")], 0).memory;
    let next = step(memory, [line("So the renewal is next week.")], 1500);
    expect(next.fresh).toEqual([line("So the renewal is next week.")]);
    memory = next.memory;
    memory = step(memory, [line("So the renewal is next week, and pricing is open.")], 3000).memory;
    next = step(memory, [line("So the renewal is next week, and pricing is open.")], 4500);
    expect(next.fresh).toEqual([line("and pricing is open.")]);
  });

  it("drops repeats by normalised words and a revised word in a recent line", () => {
    let memory = step(EMPTY_CAPTIONS, [line("We sign on Friday.")]).memory;
    const sameWords = step(memory, [line("we sign on friday"), line("Next.")], 1500);
    expect(sameWords.fresh).toEqual([]);
    memory = step(sameWords.memory, [line("Next."), line("The discount is twenty percent for the whole year.")], 3000).memory;
    memory = step(memory, [line("The discount is twenty percent for the whole year."), line("Okay then.")], 4500).memory;
    const revised = step(memory, [line("The discount is twenty per cent for the whole year."), line("Okay then.")], 6000);
    // "Okay then." settled (same at two reads); the revised discount line is not sent again.
    expect(revised.fresh).toEqual([line("Okay then.")]);
  });

  it("forgets lines after the keep window", () => {
    const memory = { primed: true, seen: [{ key: captionKey("Thanks everyone."), at: 0 }], lastKey: null };
    expect(step(memory, [line("Thanks everyone."), line("Bye.")], 11 * 60_000).fresh).toEqual([line("Thanks everyone.")]);
  });
});

describe("echoesOwnLine", () => {
  it("matches a caption of the user's own mic line, not another speaker's", () => {
    expect(echoesOwnLine("when does SSO ship for enterprise customers", ["When does SSO ship for enterprise customers?"])).toBe(true);
    expect(echoesOwnLine("we can do fifteen percent", ["When does SSO ship for enterprise customers?"])).toBe(false);
    expect(echoesOwnLine("anything", [])).toBe(false);
  });
});

describe("meetingTerms and meetingWindowBrief", () => {
  it("joins the name and people for retrieval", () => {
    expect(meetingTerms({ app: "teams", title: "Acme renewal", participants: ["Priya Patel", "Bob Jones"] })).toBe("Acme renewal Priya Patel Bob Jones");
    expect(meetingTerms({ app: "zoom", title: null, participants: [] })).toBe("");
    expect(meetingTerms(null)).toBe("");
  });

  it("writes brief lines only when the window names the meeting or its people", () => {
    expect(meetingWindowBrief({ app: "zoom", title: null, participants: ["Dana Wu", "Eli Brown"] })).toBe(
      "Meeting window: Zoom (read from the window on this device)\nPeople in the meeting window: Dana Wu, Eli Brown",
    );
    expect(meetingWindowBrief({ app: "meet", title: "Acme renewal", participants: [] })).toBe('Meeting window: Google Meet, "Acme renewal" (read from the window on this device)');
    const many = Array.from({ length: 15 }, (_, index) => `Person ${String.fromCharCode(65 + index)}`);
    expect(meetingWindowBrief({ app: "teams", title: null, participants: many })).toContain("(+3 more)");
    expect(meetingWindowBrief({ app: "zoom", title: null, participants: [] })).toBe("");
  });
});
