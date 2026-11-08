import { describe, expect, it } from "vitest";
import { FOR_BEE_TIP, NOT_DONE_TIP, claimsComputerAction, guardMeetingTips } from "./meeting-claims";

const tip = (text: string) => ({ text, source: null });

describe("claimsComputerAction", () => {
  it.each([
    "Opening Chrome now, as requested.",
    "Opened Chrome.",
    "Bee has opened Chrome.",
    "I'm typing hi in the form.",
    "Sent the message to Priya, as requested.",
    "Clicked Help.",
  ])("flags %s", (line) => expect(claimsComputerAction(line)).toBe(true));

  it.each([
    'Say "I sent the deck on Monday."',
    "Not opened yet.",
    "Bee could not open Chrome.",
    "The Circle line is closed this weekend.",
    "Priya sent the deck on Monday.",
    "Ask Priya to send the notes.",
  ])("passes %s", (line) => expect(claimsComputerAction(line)).toBe(false));
});

describe("guardMeetingTips", () => {
  it("points a Bee request to Talk to Bee (typed), never \"say Bee first\"", () => {
    const out = guardMeetingTips([tip("Opening Chrome now, as requested.")], ["Bee, open Chrome"]);
    expect(out.map((t) => t.text)).toEqual([FOR_BEE_TIP]);
    expect(FOR_BEE_TIP).not.toMatch(/say .?bee.? first/i);
  });

  it("says nothing was done when the line is not a request to Bee", () => {
    expect(guardMeetingTips([tip("Opened Chrome.")], ["Priya: open Chrome"]).map((t) => t.text)).toEqual([NOT_DONE_TIP]);
  });

  it("keeps other tips and collapses repeated swaps", () => {
    const out = guardMeetingTips([tip("Opening Chrome."), tip("Typed hi."), tip('Say "Can we move it?"')], ["Bee open Chrome"]);
    expect(out.map((t) => t.text)).toEqual([FOR_BEE_TIP, 'Say "Can we move it?"']);
  });

  it("leaves honest tips untouched", () => {
    const tips = [tip("15% of 18,000 is 2,700.")];
    expect(guardMeetingTips(tips, ["Bee, what is 15% of 18000"])).toEqual(tips);
  });
});
