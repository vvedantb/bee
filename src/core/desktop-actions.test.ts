import { describe, expect, it } from "vitest";
import { BLOCKED_APP_MESSAGE, appKey, cleanAppName, cleanWindowTitle, matchRunningApp, openedUrlMessage, requestedUrl, resolveApp, routeCommand } from "./desktop-actions";

describe("cleanAppName", () => {
  it("keeps plain app names, without quotes, end stops, 'the' or 'app'", () => {
    expect(cleanAppName("Microsoft Teams")).toBe("Microsoft Teams");
    expect(cleanAppName('"Teams".')).toBe("Teams");
    expect(cleanAppName("the Slack app")).toBe("Slack");
    expect(cleanAppName("  zoom.us  ")).toBe("zoom.us");
    expect(cleanAppName("Outlook (classic)")).toBe("Outlook (classic)");
    expect(cleanAppName("AT&T Connect")).toBe("AT&T Connect");
  });

  it("refuses paths, URLs, flags, shell marks and long names", () => {
    for (const name of [
      "",
      "/Applications/Evil.app",
      "C:\\Windows\\System32\\cmd.exe",
      "../../bin/sh",
      "~/evil",
      "-n",
      "--args",
      ".hidden",
      "https://example.com",
      "Teams; rm -rf /",
      "Teams && calc",
      "Safari --args",
      "Teams | sh",
      "$(whoami)",
      "`id`",
      "Teams\nSlack",
      "a".repeat(61),
    ]) {
      expect(cleanAppName(name), name).toBeNull();
    }
  });
});

describe("resolveApp", () => {
  it("knows common apps by short names, with each OS's own target", () => {
    expect(resolveApp("teams")).toEqual({ ok: true, app: { label: "Teams", mac: "Microsoft Teams", win: { uri: "msteams:", startMenu: ["Microsoft Teams", "Teams"] }, known: true } });
    expect(resolveApp("Microsoft Teams").ok && resolveApp("the Teams app")).toMatchObject({ ok: true, app: { label: "Teams" } });
    expect(resolveApp("google chrome")).toMatchObject({ ok: true, app: { label: "Chrome", mac: "Google Chrome", win: { startMenu: ["Google Chrome"] } } });
    expect(resolveApp("Zoom")).toMatchObject({ ok: true, app: { mac: "zoom.us", win: { startMenu: ["Zoom Workplace", "Zoom"] } } });
    expect(resolveApp("Notepad")).toMatchObject({ ok: true, app: { mac: null, win: { exe: "notepad.exe", startMenu: [] } } });
    expect(resolveApp("Finder")).toMatchObject({ ok: true, app: { win: null } });
  });

  it("uses any other plain name as given", () => {
    expect(resolveApp("Figma")).toEqual({ ok: true, app: { label: "Figma", mac: "Figma", win: { startMenu: ["Figma"] }, known: false } });
  });

  it("refuses shells, script tools and system tools, however they are named", () => {
    for (const name of ["Terminal", "the Terminal app", "iTerm2", "PowerShell", "cmd", "Command Prompt", "Windows Terminal", "Script Editor", "regedit", "bash", "Keychain Access", "logoff"]) {
      expect(resolveApp(name), name).toEqual({ ok: false, message: BLOCKED_APP_MESSAGE });
    }
    expect(resolveApp("/bin/sh")).toEqual({ ok: false, message: "That is not an app name Bee can open" });
  });
});

describe("matchRunningApp", () => {
  const teams = resolveApp("Teams");
  if (!teams.ok) throw new Error("Teams resolves");

  it("finds the running app by any of its names, exact first", () => {
    expect(matchRunningApp(teams.app, [{ name: "Slack" }, { name: "Microsoft Teams" }])).toEqual({ name: "Microsoft Teams" });
    expect(matchRunningApp(teams.app, [{ name: "Microsoft Teams (work or school)" }])).toEqual({ name: "Microsoft Teams (work or school)" });
    expect(matchRunningApp(teams.app, [{ name: "Teams Helper" }, { name: "Teams" }])).toEqual({ name: "Teams" });
    expect(matchRunningApp(teams.app, [{ name: "Slack" }])).toBeNull();
  });

  it("matches a name Bee does not know only exactly or as a prefix", () => {
    const figma = resolveApp("Figma");
    if (!figma.ok) throw new Error("Figma resolves");
    expect(matchRunningApp(figma.app, [{ name: "Figma Agent" }])).toEqual({ name: "Figma Agent" });
    expect(matchRunningApp(figma.app, [{ name: "NotFigma" }])).toBeNull();
  });
});

describe("cleanWindowTitle", () => {
  it("keeps one plain line and refuses control characters, flags and long titles", () => {
    expect(cleanWindowTitle("  Weekly   standup ")).toBe("Weekly standup");
    expect(cleanWindowTitle(undefined)).toBeNull();
    expect(cleanWindowTitle("--headed")).toBeNull();
    expect(cleanWindowTitle("a\u0007b")).toBeNull();
    expect(cleanWindowTitle("x".repeat(121))).toBeNull();
  });
});

describe("requestedUrl", () => {
  it("reads full URLs and bare web addresses as https", () => {
    expect(requestedUrl("https://www.bbc.co.uk/news")).toBe("https://www.bbc.co.uk/news");
    expect(requestedUrl("bbc.co.uk")).toBe("https://bbc.co.uk/");
    expect(requestedUrl("www.example.org/a?utm_source=x&b=1.")).toBe("https://www.example.org/a?b=1");
    expect(requestedUrl("github.com/vvedantb/bee")).toBe("https://github.com/vvedantb/bee");
  });

  it("refuses file names, local hosts and other schemes", () => {
    for (const text of ["notes.md", "deck.pptx", "Teams", "localhost:3000", "http://127.0.0.1", "file:///etc/passwd", "javascript:alert(1)", "ftp://example.com", "https://user:pass@example.com"]) {
      expect(requestedUrl(text), text).toBeNull();
    }
  });

  it("shows the opened URL in full, cut to fit", () => {
    expect(openedUrlMessage("https://www.bbc.co.uk/news")).toBe("Opened https://www.bbc.co.uk/news");
    expect(openedUrlMessage(`https://example.com/${"a".repeat(100)}`)).toHaveLength("Opened ".length + 80);
  });
});

describe("routeCommand", () => {
  it("runs open or switch to a known app at once, without the AI", () => {
    expect(routeCommand("open Teams")).toEqual({ kind: "open-app", name: "Teams" });
    expect(routeCommand("Open Teams.")).toEqual({ kind: "open-app", name: "Teams" });
    expect(routeCommand('open Teams"')).toEqual({ kind: "open-app", name: "Teams" });
    expect(routeCommand("please launch Microsoft Outlook")).toEqual({ kind: "open-app", name: "Outlook" });
    expect(routeCommand("can you open the Slack app for me?")).toEqual({ kind: "open-app", name: "Slack" });
    expect(routeCommand("start Zoom now")).toEqual({ kind: "open-app", name: "Zoom" });
    expect(routeCommand("switch to Teams")).toEqual({ kind: "focus-app", name: "Teams" });
    expect(routeCommand("bring up Chrome")).toEqual({ kind: "focus-app", name: "Chrome" });
    expect(routeCommand("go to Excel")).toEqual({ kind: "focus-app", name: "Excel" });
  });

  it("opens a web address at once", () => {
    expect(routeCommand("open bbc.co.uk")).toEqual({ kind: "open-url", url: "https://bbc.co.uk/" });
    expect(routeCommand("go to https://github.com/vvedantb/bee")).toEqual({ kind: "open-url", url: "https://github.com/vvedantb/bee" });
  });

  it("sends anything else to the AI: questions, unknown apps, two steps, files and blocked apps", () => {
    for (const command of [
      "what's 15% of 18000?",
      "open Figma",
      "open Teams and share my screen",
      "open the Acme deck",
      "open notes.md",
      "open notes",
      "open Terminal",
      "show me the revenue numbers",
      "send Priya a message",
      "close Teams",
      "type hello into Slack",
      "",
    ]) {
      expect(routeCommand(command), command).toEqual({ kind: "ai" });
    }
  });

  it("compares names by appKey", () => {
    expect(appKey("  The  Microsoft Teams   app ")).toBe("microsoft teams");
    expect(appKey("Code.exe")).toBe("code");
  });
});
