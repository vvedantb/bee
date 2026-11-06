import { describe, expect, it } from "vitest";
import { APP_PLAYBOOKS, playbookBlock, playbooksFor } from "./app-playbooks";

const apps = (text: string) => playbooksFor(text).map((book) => book.app);

describe("playbooksFor", () => {
  it("finds the apps a request names, as whole words in any case", () => {
    expect(apps("message Sam in Teams")).toEqual(["Microsoft Teams"]);
    expect(apps("open MS TEAMS and ping Priya")).toEqual(["Microsoft Teams"]);
    expect(apps("post in slack, then close the Chrome tab")).toEqual(["Slack", "Google Chrome"]);
    expect(apps("send it on Discord")).toEqual(["Discord"]);
  });

  it("finds none when no app is named, or a word only contains a name", () => {
    expect(apps("click the Send button")).toEqual([]);
    expect(apps("check my steams library")).toEqual([]);
    expect(apps("what is on the agenda?")).toEqual([]);
  });

  it("keeps a request naming many apps to a short list", () => {
    expect(apps("teams slack discord outlook chrome edge")).toHaveLength(3);
  });
});

describe("playbookBlock", () => {
  it("gives the hint for this computer's keys", () => {
    expect(playbookBlock("message Sam in Teams", "windows")).toContain("Microsoft Teams: ctrl+e goes to the search box");
    expect(playbookBlock("message Sam in Teams", "mac")).toContain("Microsoft Teams: cmd+e goes to the search box");
    expect(playbookBlock("click Send", "mac")).toBe("");
  });

  it("keeps every hint short, with the right modifier for its OS", () => {
    for (const book of APP_PLAYBOOKS) {
      const hints = Object.entries(book.hints);
      expect(hints.length, book.app).toBeGreaterThan(0);
      for (const [os, hint] of hints) expect(hint?.length ?? 0, `${book.app} ${os}`).toBeLessThanOrEqual(200);
      if (book.hints.mac) expect(book.hints.mac).not.toMatch(/\bctrl\+/);
      if (book.hints.windows) expect(book.hints.windows).not.toMatch(/\bcmd\+/);
      if (book.hints.linux) expect(book.hints.linux).not.toMatch(/\bcmd\+/);
    }
  });

  it("gives Linux hints for Chrome, Firefox, LibreOffice and file managers, with list_apps names", () => {
    expect(playbookBlock("open Chrome and close the tab", "linux")).toContain("Google Chrome: list_apps names it google-chrome or chromium. ctrl+l");
    expect(playbookBlock("type a note in LibreOffice Writer", "linux")).toContain("LibreOffice: open_app libreoffice");
    expect(playbookBlock("rename the report in Thunar", "linux")).toContain("File manager: ctrl+l goes to the location bar");
    expect(playbookBlock("open a tab in firefox", "linux")).toContain("Firefox: list_apps names it firefox.");
  });

  it("makes up no Linux way into Teams or Outlook, and no Windows or Mac one for Linux file managers", () => {
    expect(playbookBlock("message Sam in Teams", "linux")).toBe("");
    expect(playbookBlock("email Sam from Outlook", "linux")).toBe("");
    expect(playbookBlock("rename it in Thunar", "mac")).toBe("");
    expect(playbookBlock("rename it in Thunar", "windows")).toBe("");
    // An app with no hint here never takes a place from one that has one.
    expect(playbooksFor("teams outlook slack chrome firefox", "linux").map((book) => book.app)).toEqual(["Slack", "Google Chrome", "Firefox"]);
  });
});
