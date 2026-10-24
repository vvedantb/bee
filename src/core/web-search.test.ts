import { describe, expect, it } from "vitest";
import { lunaTools } from "./tools";
import { isCurrent, isStable, needsWebSearch, searchLocation } from "./web-search";

const NEWS_ANSWER = ["Planned tube closures on the District line this weekend", "Strike action on Southern rail Monday"];

describe("needsWebSearch", () => {
  it("searches for current events, news, weather, scores, prices and office holders", () => {
    for (const line of [
      "what's in the news in London today",
      "what's the weather forecast for London this weekend",
      "what was the score last night",
      "what's the price of bitcoin",
      "who is the current prime minister",
      "any tube closures this weekend",
      "has the new iPhone been released",
      "convert 100 dollars to pounds",
    ]) {
      expect(needsWebSearch({ lines: [line] }), line).toBe(true);
    }
  });

  it("does not search for arithmetic, in digits or number words", () => {
    for (const line of [
      "what is fifteen percent of eighteen thousand",
      "what's 15% of 18,000",
      "what is twelve times seven",
      "how much is 340 divided by 4",
      "what's the square root of 144",
      "what percentage is 30 of 120",
    ]) {
      expect(needsWebSearch({ lines: [line] }), line).toBe(false);
    }
  });

  it("does not search for definitions and stable facts", () => {
    for (const line of [
      "define amortisation",
      "what does EBITDA mean",
      "what's the meaning of churn",
      "what is the capital of France",
      "who wrote Hamlet",
      "how many days in a leap year",
      "how many feet in a mile",
    ]) {
      expect(needsWebSearch({ lines: [line] }), line).toBe(false);
    }
  });

  it("keeps search for a follow-up to a searched answer", () => {
    expect(needsWebSearch({ lines: ["why are there tube closures"], context: ["what's in the news in London today", ...NEWS_ANSWER], searched: true })).toBe(true);
    // No current-events words in the line itself: the searched answer before it is enough.
    expect(needsWebSearch({ lines: ["and the Elizabeth line"], searched: true })).toBe(true);
    expect(needsWebSearch({ lines: ["and the Elizabeth line"], context: ["what's in the news in London today"] })).toBe(true);
  });

  it("still skips a sum that follows a searched answer", () => {
    expect(needsWebSearch({ lines: ["what is fifteen percent of eighteen thousand"], context: ["why are there tube closures", ...NEWS_ANSWER], searched: true })).toBe(false);
  });

  it("searches an open question it cannot classify, and skips plain talk", () => {
    expect(needsWebSearch({ lines: ["who runs the Acme account at Globex"] })).toBe(true);
    expect(needsWebSearch({ lines: ["let's pick up the Acme renewal"] })).toBe(false);
    expect(needsWebSearch({ lines: ["um", "okay"] })).toBe(false);
    expect(needsWebSearch({ lines: [] })).toBe(false);
  });

  it("reads every line of a steered turn", () => {
    expect(needsWebSearch({ lines: ["what's the weather forecast for London this weekend", "actually make that for Paris instead"] })).toBe(true);
  });

  it("classifies single lines", () => {
    expect(isCurrent("latest headlines")).toBe(true);
    expect(isCurrent("fifteen percent of eighteen thousand")).toBe(false);
    expect(isStable("fifteen percent of eighteen thousand")).toBe(true);
    expect(isStable("what's in the news")).toBe(false);
  });
});

describe("searchLocation", () => {
  it("derives London, GB from Europe/London, whatever the locale", () => {
    expect(searchLocation({ timeZone: "Europe/London", locale: "en-US" })).toEqual({ type: "approximate", city: "London", country: "GB", timezone: "Europe/London" });
  });

  it("turns underscores in the zone's city into spaces", () => {
    expect(searchLocation({ timeZone: "America/New_York", locale: "en-US" })).toEqual({ type: "approximate", city: "New York", country: "US", timezone: "America/New_York" });
  });

  it("falls back to the locale's region for an unknown zone, without a city", () => {
    expect(searchLocation({ timeZone: "Europe/Kyiv", locale: "uk-UA" })).toEqual({ type: "approximate", country: "UA", timezone: "Europe/Kyiv" });
    expect(searchLocation({ timeZone: "UTC", locale: "en-GB" })).toEqual({ type: "approximate", country: "GB" });
    expect(searchLocation({ timeZone: "Etc/GMT+1", locale: "de-DE" })).toEqual({ type: "approximate", country: "DE" });
  });

  it("is undefined when neither the zone nor the locale names a place", () => {
    expect(searchLocation({ timeZone: "UTC", locale: "en" })).toBeUndefined();
    expect(searchLocation({ timeZone: "UTC", locale: "not a locale!" })).toBeUndefined();
    expect(searchLocation({})).toBeUndefined();
  });

  it("is passed to Anthropic's web search tool as userLocation, with no domain allow-list", () => {
    const location = searchLocation({ timeZone: "Europe/London", locale: "en-GB" });
    const tool = lunaTools({ location }).web_search;
    expect(tool).toMatchObject({ args: { maxUses: 3, userLocation: { type: "approximate", city: "London", country: "GB", timezone: "Europe/London" } } });
    expect(tool).not.toHaveProperty("args.allowedDomains");
    expect(lunaTools().web_search).not.toHaveProperty("args.userLocation");
  });
});
