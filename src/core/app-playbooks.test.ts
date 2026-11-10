import { describe, expect, it } from "vitest";
import { APP_PLAYBOOKS, isTeamsApp, playbookBlock, playbooksFor, teamsTip } from "./app-playbooks";

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

  it("keeps every hint short, with one for each OS", () => {
    for (const book of APP_PLAYBOOKS) {
      expect(book.hints.mac.length, book.app).toBeLessThanOrEqual(200);
      expect(book.hints.windows.length, book.app).toBeLessThanOrEqual(200);
      expect(book.hints.mac).not.toMatch(/\bctrl\+/);
    }
  });
});

describe("playbookBlock on Linux", () => {
  it("gives Linux the ctrl keys, never cmd", () => {
    const block = playbookBlock("open Slack", "linux");
    expect(block).toMatch(/ctrl\+k/);
    expect(block).not.toMatch(/cmd\+/);
  });
});

describe("Teams tip", () => {
  it("knows Teams by any process or display name, and no other app", () => {
    for (const name of ["Teams", "Microsoft Teams", "ms-teams.exe", "Teams.exe", "MS Teams"]) expect(isTeamsApp(name), name).toBe(true);
    for (const name of ["Slack", "teams-helper.exe", "Steams", "Outlook"]) expect(isTeamsApp(name), name).toBe(false);
  });

  it("gives the playbook's Teams hint for the OS", () => {
    expect(teamsTip("windows")).toBe("Teams tip: ctrl+e goes to the search box: press it, set_value the person's or chat's name, then pick the match from the results. ctrl+n starts a new chat.");
    expect(teamsTip("mac")).toMatch(/^Teams tip: cmd\+e goes to the search box/);
  });
});
