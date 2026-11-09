import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionLine } from "./session-lines";
import { AWAY_MS, beeLines, type RecapEvent, createAwayTracker, isRecapRequest, localMeetingLines, missedLines, parseRecap, recapBody, summariseRecap } from "./recap";

// "What did I miss?": the pure parts, and the one AI call with a mock model (no network).

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: undefined } };

function model(reply: string | Error) {
  const prompts: string[] = [];
  const mock = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      if (reply instanceof Error) throw reply;
      return { content: [{ type: "text", text: reply }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
    },
  });
  return { mock, prompts };
}

let seq = 0;
const line = (speakerName: string, text: string, clientTs: number, own = false): SessionLine => {
  seq += 1;
  return { id: `l-${seq}`, own, speakerId: speakerName, speakerName, text, clientTs, serverTs: null };
};

beforeEach(() => {
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("recap", () => {
  it("takes other people's lines with content since the time, never the user's own", () => {
    const lines = [
      line("Priya", "We agreed on the Q3 launch date.", 100),
      line("Sam", "Okay.", 300),
      line("Me", "I will send the deck.", 400, true),
      line("Priya", "Sam owns the pricing page.", 500),
    ];
    expect(missedLines(lines, 200).map((item) => item.text)).toEqual(["Sam owns the pricing page."]);
    expect(missedLines(lines, 0).map((item) => item.text)).toEqual(["We agreed on the Q3 launch date.", "Sam owns the pricing page."]);
  });

  it("lists Bee's own activity since the time", () => {
    const events: RecapEvent[] = [
      { kind: "job", at: 50, title: "Old task", failed: false },
      { kind: "job", at: 150, title: "Draft release notes", failed: false },
      { kind: "job", at: 160, title: "Post in Slack", failed: true },
      { kind: "briefing", at: 170, subject: "Weekly sync" },
      { kind: "summary", at: 180, text: 'Saved "Weekly sync": 2 action items' },
    ];
    expect(beeLines(events, 100)).toEqual([
      "Background task done: Draft release notes",
      "Background task failed: Post in Slack",
      "Briefing shown: Weekly sync",
      'Saved "Weekly sync": 2 action items',
    ]);
  });

  it("lists a few lines as they are, and sums up more without AI: a count, the names and the last two", () => {
    const two = [line("Priya", "Launch is on the 4th.", 1), line("Sam", "I'll check legal.", 2)];
    expect(localMeetingLines(two)).toEqual(["Priya: Launch is on the 4th.", "Sam: I'll check legal."]);
    const many = [...two, line("Meeting", "Budget is fine.", 3), line("Ana", "Ship it.", 4), line("Lee", "Agreed.", 5)];
    expect(localMeetingLines(many)).toEqual(["5 lines from Priya, Sam, Meeting and 2 others. Latest:", "Ana: Ship it.", "Lee: Agreed."]);
  });

  it("clips each line to 110 characters and keeps at most five, saying how many more", () => {
    const long = "word ".repeat(40);
    const body = recapBody([long, "b", "c"], ["d", "e", "f", "g"]);
    expect(body).toHaveLength(5);
    expect(body[0]?.length).toBeLessThanOrEqual(110);
    expect(body[0]?.endsWith("…")).toBe(true);
    expect(body.at(-1)).toBe("and 3 more");
    expect(recapBody(["a"], ["b"])).toEqual(["a", "b"]);
    expect(recapBody([], [])).toEqual([]);
  });

  it("knows the recap request and its close variants, and leaves longer requests to the AI", () => {
    for (const text of ["what did I miss?", "What did I miss", "what have I missed?", "what'd I miss", "What’d I miss?", "catch me up", "fill me in please", "recap", "so what did I miss in the meeting?", "what happened while I was away"]) {
      expect(isRecapRequest(text), text).toBe(true);
    }
    for (const text of ["what did I miss in Sam's email?", "open Teams", "what did Priya say about the recap deck"]) {
      expect(isRecapRequest(text), text).toBe(false);
    }
  });

  it("reads at most three bullets from the AI, and null when it wrote none", () => {
    expect(parseRecap("Here you go:\n- Launch moved to the 4th\n* Sam owns pricing\n- a\n- b")).toEqual(["Launch moved to the 4th", "Sam owns pricing", "a"]);
    expect(parseRecap("Nothing happened.")).toBeNull();
  });

  it("asks the model once with the lines, and returns null on failure", async () => {
    const ok = model("- Launch moved to the 4th\n- Sam owns pricing");
    expect(await summariseRecap({ model: ok.mock, lines: ["Priya: Launch is on the 4th now.", "Priya: Sam owns pricing."] })).toEqual(["Launch moved to the 4th", "Sam owns pricing"]);
    expect(ok.prompts).toHaveLength(1);
    expect(ok.prompts[0]).toContain("Use only facts from the lines");
    expect(ok.prompts[0]).toContain("- Priya: Sam owns pricing.");
    expect(await summariseRecap({ model: model(new Error("down")).mock, lines: ["Priya: hi there"] })).toBeNull();
  });
});

describe("away tracker", () => {
  it("returns when the user left, once, after 15 minutes with no input", () => {
    const away = createAwayTracker();
    expect(away.idle(1_000_000, AWAY_MS - 1)).toBeNull();
    expect(away.idle(2_000_000, AWAY_MS + 5000)).toBeNull();
    expect(away.idle(2_100_000, 1000)).toBe(2_000_000 - AWAY_MS - 5000);
    expect(away.idle(2_105_000, 0)).toBeNull();
  });

  it("counts a locked screen or sleep, and ignores idle time until both end", () => {
    const away = createAwayTracker();
    away.leave("lock", 0);
    away.leave("suspend", 10);
    // Idle time resets around the lock: it says nothing while locked.
    expect(away.idle(AWAY_MS, 0)).toBeNull();
    expect(away.back("suspend", AWAY_MS + 10)).toBeNull();
    expect(away.back("lock", AWAY_MS + 20)).toBe(0);
    // A short lock is not away.
    away.leave("lock", 0);
    expect(away.back("lock", 60_000)).toBeNull();
  });
});
