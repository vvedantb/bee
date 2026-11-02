import { describe, expect, it } from "vitest";
import { routeLine, wakeCommand, type LineSource } from "./wake-word";

describe("wakeCommand", () => {
  it("takes the request after Bee, with or without a comma", () => {
    expect(wakeCommand("Bee open Teams")).toBe("open Teams");
    expect(wakeCommand("Bee, what's 15% of 18000?")).toBe("what's 15% of 18000?");
    expect(wakeCommand("bee, open Outlook.")).toBe("open Outlook.");
    expect(wakeCommand("BEE OPEN TEAMS")).toBe("OPEN TEAMS");
    expect(wakeCommand("Bee. Open Teams.")).toBe("Open Teams.");
    expect(wakeCommand("Bee! Summarise the last point.")).toBe("Summarise the last point.");
    expect(wakeCommand("Bee: open bbc.co.uk")).toBe("open bbc.co.uk");
    expect(wakeCommand("Bee — open Slack")).toBe("open Slack");
    expect(wakeCommand('  "Bee, open Teams"')).toBe('open Teams"');
  });

  it("takes Hey Bee, in its spellings", () => {
    expect(wakeCommand("Hey Bee open Teams")).toBe("open Teams");
    expect(wakeCommand("Hey Bee, what time is it in Tokyo?")).toBe("what time is it in Tokyo?");
    expect(wakeCommand("Hey, Bee, open Teams")).toBe("open Teams");
    expect(wakeCommand("hey bee. open teams")).toBe("open teams");
    expect(wakeCommand("Hey B, open Teams")).toBe("open Teams");
    expect(wakeCommand("Hey Be open Teams")).toBe("open Teams");
  });

  it("takes B, Be and Bea at the very start: after a pause, or before an action or a question", () => {
    expect(wakeCommand("B open Teams")).toBe("open Teams");
    expect(wakeCommand("B, what's 15% of 18000?")).toBe("what's 15% of 18000?");
    expect(wakeCommand("Be, open Teams")).toBe("open Teams");
    expect(wakeCommand("Be open Teams")).toBe("open Teams");
    expect(wakeCommand("Be what's the weather in Paris")).toBe("what's the weather in Paris");
    expect(wakeCommand("Bea, open Teams")).toBe("open Teams");
    expect(wakeCommand("Bea open Teams")).toBe("open Teams");
    expect(wakeCommand("Be, the deck is late")).toBe("the deck is late");
    expect(wakeCommand("b can you open teams")).toBe("can you open teams");
  });

  it("is the empty request for Bee alone, and nothing for B, Be or Bea alone", () => {
    expect(wakeCommand("Bee.")).toBe("");
    expect(wakeCommand("Hey Bee!")).toBe("");
    expect(wakeCommand("Bee")).toBe("");
    expect(wakeCommand("Be.")).toBeNull();
    expect(wakeCommand("B")).toBeNull();
    expect(wakeCommand("Bea?")).toBeNull();
  });

  it("never wakes on the word mid-sentence", () => {
    for (const line of [
      "to be or not to be",
      "maybe later",
      "the bee flew past",
      "I'll be there",
      "It will be fine, Bee",
      "Let it be, open Teams later",
      "We should open Teams. Bee, focus.",
      "Plan B, open the doc",
      "and Bee open Teams",
    ]) {
      expect(wakeCommand(line), line).toBeNull();
    }
  });

  it("never wakes on words that only start like the name", () => {
    for (const line of ["Bees are dying", "Been there", "Because open Teams", "Beer later?", "B2B pricing open questions", "BBC news", "Bee's knees", "B-tree open issue", "Bean counters", "Beatrice open Teams"]) {
      expect(wakeCommand(line), line).toBeNull();
    }
  });

  it("does not take B, Be or Bea before ordinary speech", () => {
    for (const line of ["Be careful with the numbers", "Be there at five", "Be sure to send the deck", "B is the backup plan", "B could work too", "Bea said she would join", "Hey, be quick"]) {
      expect(wakeCommand(line), line).toBeNull();
    }
  });
});

describe("routeLine", () => {
  const sources: LineSource[] = ["typed", "caption", "teams-audio", "teammate"];

  it("sends an own mic phrase with the wake word to the AI as a command", () => {
    expect(routeLine({ text: "Bee open Teams", source: "mic", enabled: true })).toEqual({ kind: "command", command: "open Teams" });
    expect(routeLine({ text: "Hey Bee, what's 15% of 18000?", source: "mic", enabled: true })).toEqual({ kind: "command", command: "what's 15% of 18000?" });
  });

  it("keeps other mic phrases in the meeting", () => {
    expect(routeLine({ text: "Let's pick up the Acme renewal.", source: "mic", enabled: true })).toEqual({ kind: "meeting" });
    expect(routeLine({ text: "maybe later", source: "mic", enabled: true })).toEqual({ kind: "meeting" });
  });

  it("never wakes on typed lines, captions, Teams audio or teammates' lines", () => {
    for (const source of sources) {
      expect(routeLine({ text: "Bee open Teams", source, enabled: true }), source).toEqual({ kind: "meeting" });
      expect(routeLine({ text: "Bee.", source, enabled: true }), source).toEqual({ kind: "meeting" });
      expect(routeLine({ text: "open Teams", source, enabled: true, armed: true }), source).toEqual({ kind: "meeting" });
    }
  });

  it("does nothing with the setting off", () => {
    expect(routeLine({ text: "Bee open Teams", source: "mic", enabled: false })).toEqual({ kind: "meeting" });
    expect(routeLine({ text: "open Teams", source: "mic", enabled: false, armed: true })).toEqual({ kind: "meeting" });
  });

  it("arms on Bee alone, and takes the next mic phrase as the request", () => {
    expect(routeLine({ text: "Bee.", source: "mic", enabled: true })).toEqual({ kind: "wake" });
    expect(routeLine({ text: "Open Teams.", source: "mic", enabled: true, armed: true })).toEqual({ kind: "command", command: "Open Teams." });
    // A second wake word in the follow-up is stripped like any other.
    expect(routeLine({ text: "Bee, open Teams", source: "mic", enabled: true, armed: true })).toEqual({ kind: "command", command: "open Teams" });
    // Filler is not a request.
    expect(routeLine({ text: "um", source: "mic", enabled: true, armed: true })).toEqual({ kind: "meeting" });
  });
});
