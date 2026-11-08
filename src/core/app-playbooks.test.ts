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
