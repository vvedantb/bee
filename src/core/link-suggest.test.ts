import { describe, expect, it } from "vitest";
import { detectLinks, mergeChips, visibleChips, MAX_CHIPS } from "./link-suggest";

const domains = (text: string) => detectLinks(text).map((chip) => chip.domain);

describe("detectLinks: positives", () => {
  it("finds explicit URLs and keeps the path", () => {
    expect(detectLinks("see https://example.com/path now")[0]).toEqual({ id: "example.com", domain: "example.com", url: "https://example.com/path" });
    expect(detectLinks("http://example.com")[0]?.url).toBe("http://example.com/");
  });

  it("trims trailing punctuation and tracking params", () => {
    expect(detectLinks("Go to https://example.com/a?utm_source=x&id=1.")[0]?.url).toBe("https://example.com/a?id=1");
  });

  it("finds bare domains", () => {
    expect(domains("try convex.dev today")).toEqual(["convex.dev"]);
  });

  it("drops www from the label but keeps it in the URL", () => {
    const [chip] = detectLinks("open www.github.com");
    expect(chip?.domain).toBe("github.com");
    expect(chip?.url).toBe("https://www.github.com/");
  });

  it("finds spoken forms", () => {
    expect(domains("go to convex dot com")).toEqual(["convex.com"]);
    expect(domains("Convex dot dev")).toEqual(["convex.dev"]);
    expect(domains("www dot github dot com")).toEqual(["github.com"]);
  });

  it("finds a bare domain with a path", () => {
    expect(detectLinks("github.com/vercel/next.js")[0]?.url).toBe("https://github.com/vercel/next.js");
  });

  it("matches curated service names", () => {
    expect(domains("Check the Vercel dashboard")).toEqual(["vercel.com"]);
    expect(domains("open GitHub")).toEqual(["github.com"]);
    expect(domains("the Convex dashboard")).toEqual(["dashboard.convex.dev"]);
  });

  it("orders chips by position", () => {
    expect(domains("open GitHub then convex.dev")).toEqual(["github.com", "convex.dev"]);
  });
});

describe("detectLinks: spaced dots and Notion", () => {
  it.each([
    ["try convex . dev", "convex.dev"],
    ["convex. dev", "convex.dev"],
    ["convex .dev", "convex.dev"],
  ])("reads %s", (text, domain) => {
    expect(detectLinks(text).map((chip) => chip.domain)).toEqual([domain]);
  });

  it.each(["open Notion", "in Notion", "Notion dashboard"])("matches %s", (text) => {
    expect(detectLinks(text).map((chip) => chip.domain)).toEqual(["notion.so"]);
  });
});

describe("detectLinks: negatives", () => {
  it.each([
    "e.g. this sentence",
    "i.e. that one, vs. the other",
    "see index.js",
    "package.json",
    "open app.tsx",
    "version 1.2.3",
    "v2.0.1",
    "we should not",
    "dot com alone",
    "foo.notarealtld",
    "hello.world",
    "mail me at sam@example.com",
    "run setup.sh",
    "it ended. In the end we left",
    "the dot in the middle",
    "a.b.c",
    "see 10.20.com",
    "I have no notion of that",
    "Version 2. 0 is out",
    "That is fine. Dev work is next",
  ])("ignores %s", (text) => {
    expect(detectLinks(text)).toEqual([]);
  });

  it("does not match a service name inside a filename", () => {
    expect(detectLinks("github.js")).toEqual([]);
  });
});

describe("dedupe and cap", () => {
  it("lists a domain once", () => {
    expect(domains("convex.dev and https://convex.dev/docs and convex dot dev")).toEqual(["convex.dev"]);
  });

  it("caps at 5", () => {
    const text = "a1.com b2.com c3.com d4.com e5.com f6.com g7.com";
    expect(detectLinks(text)).toHaveLength(MAX_CHIPS);
  });

  it("merges later chips without duplicates, still capped", () => {
    const first = detectLinks("convex.dev github.com");
    const merged = mergeChips(first, detectLinks("github.com vercel.com aa.io bb.io cc.io"));
    expect(merged.map((chip) => chip.domain)).toEqual(["convex.dev", "github.com", "vercel.com", "aa.io", "bb.io"]);
  });

  it("hides dismissed chips", () => {
    const chips = detectLinks("convex.dev github.com");
    expect(visibleChips(chips, ["convex.dev"]).map((chip) => chip.id)).toEqual(["github.com"]);
  });
});
