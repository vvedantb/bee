import { describe, expect, it } from "vitest";
import { clarifyingQuestion, requestGaps } from "./clarify";
import { nameAmbiguities } from "./known-names";

// Made-up names only. One question for everything a request to reach an ambiguous person leaves out, with no AI call.

const KNOWN = ["Chris Lee", "Krzysztof Nowak"];
const ask = (command: string, context: string[] = []) => {
  const ambiguity = nameAmbiguities(command, KNOWN)[0];
  if (!ambiguity) throw new Error(`no ambiguity in ${command}`);
  return clarifyingQuestion({ command, ambiguity, context });
};

describe("requestGaps", () => {
  it("finds the app and the message a request to message someone leaves out", () => {
    expect(requestGaps("message Chris", "Chris")).toEqual({ app: true, body: true });
    expect(requestGaps("send Chris a message", "Chris")).toEqual({ app: true, body: true });
    expect(requestGaps("send Chris a message saying hi", "Chris")).toEqual({ app: true, body: false });
    expect(requestGaps("tell chris I'm running late", "Chris")).toEqual({ app: true, body: false });
    expect(requestGaps("message Chris on Teams", "Chris")).toEqual({ app: false, body: true });
    expect(requestGaps("message Chris in Slack: the deck is ready", "Chris")).toEqual({ app: false, body: false });
    expect(requestGaps("send Chris the deck", "Chris")).toEqual({ app: true, body: false });
    expect(requestGaps("message Chris thank you", "Chris")).toEqual({ app: true, body: false });
  });

  it("takes the channel from the verb, the user's recent requests or Bee's memory", () => {
    expect(requestGaps("email Chris", "Chris")).toEqual({ app: false, body: true });
    expect(requestGaps("message Chris", "Chris", ["open Teams"])).toEqual({ app: false, body: true });
    expect(requestGaps("message Chris", "Chris", ["The user messages colleagues on Slack."])).toEqual({ app: false, body: true });
    expect(requestGaps("message Chris", "Chris", ['{"name":"google-chrome"}'])).toEqual({ app: true, body: true });
  });

  it("asks a call only for the app, and anything else for nothing more", () => {
    expect(requestGaps("call chris", "Chris")).toEqual({ app: true, body: false });
    expect(requestGaps("call chris on Zoom", "Chris")).toEqual({ app: false, body: false });
    for (const command of ["open chris's chat", "find krzys", "show Chris's messages"]) expect(requestGaps(command, "Chris"), command).toEqual({ app: false, body: false });
  });
});

describe("clarifyingQuestion", () => {
  it("asks which person, which app and what to say in one question", () => {
    expect(ask("message Chris")).toBe("Which Chris (Chris Lee or Krzysztof Nowak), which app, and what should the message say?");
    expect(ask("send Chris a message saying hi")).toBe("Which Chris (Chris Lee or Krzysztof Nowak), and which app?");
    expect(ask("message Chris on Teams")).toBe("Which Chris (Chris Lee or Krzysztof Nowak), and what should the message say?");
    expect(ask("message Chris", ["open Teams"])).toBe("Which Chris (Chris Lee or Krzysztof Nowak), and what should the message say?");
  });

  it("asks only which person when nothing else is missing", () => {
    expect(ask("message Chris on Teams saying hi")).toBe("Which Chris: Chris Lee or Krzysztof Nowak?");
    expect(ask("open chris's chat")).toBe("Which Chris: Chris Lee or Krzysztof Nowak?");
  });
});
