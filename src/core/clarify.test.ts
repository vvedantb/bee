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
    expect(requestGaps("message Kris", "Kris")).toEqual({ app: true, body: true });
    expect(requestGaps("send Kris a message", "Kris")).toEqual({ app: true, body: true });
    expect(requestGaps("send Kris a message saying hi", "Kris")).toEqual({ app: true, body: false });
    expect(requestGaps("tell kris I'm running late", "Kris")).toEqual({ app: true, body: false });
    expect(requestGaps("message Kris on Teams", "Kris")).toEqual({ app: false, body: true });
    expect(requestGaps("message Kris in Slack: the deck is ready", "Kris")).toEqual({ app: false, body: false });
    expect(requestGaps("send Kris the deck", "Kris")).toEqual({ app: true, body: false });
    expect(requestGaps("message Kris thank you", "Kris")).toEqual({ app: true, body: false });
  });

  it("takes the channel from the verb, the user's recent requests or Bee's memory", () => {
    expect(requestGaps("email Kris", "Kris")).toEqual({ app: false, body: true });
    expect(requestGaps("message Kris", "Kris", ["open Teams"])).toEqual({ app: false, body: true });
    expect(requestGaps("message Kris", "Kris", ["The user messages colleagues on Slack."])).toEqual({ app: false, body: true });
    expect(requestGaps("message Kris", "Kris", ['{"name":"google-chrome"}'])).toEqual({ app: true, body: true });
  });

  it("asks a call only for the app, and anything else for nothing more", () => {
    expect(requestGaps("call kris", "Kris")).toEqual({ app: true, body: false });
    expect(requestGaps("call kris on Zoom", "Kris")).toEqual({ app: false, body: false });
    for (const command of ["open kris's chat", "find krzys", "show Kris's messages"]) expect(requestGaps(command, "Kris"), command).toEqual({ app: false, body: false });
  });
});

describe("clarifyingQuestion", () => {
  it("asks which person, which app and what to say in one question", () => {
    expect(ask("message Kris")).toBe("Which Kris (Chris Lee or Krzysztof Nowak), which app, and what should the message say?");
    expect(ask("send Kris a message saying hi")).toBe("Which Kris (Chris Lee or Krzysztof Nowak), and which app?");
    expect(ask("message Kris on Teams")).toBe("Which Kris (Chris Lee or Krzysztof Nowak), and what should the message say?");
    expect(ask("message Kris", ["open Teams"])).toBe("Which Kris (Chris Lee or Krzysztof Nowak), and what should the message say?");
  });

  it("asks only which person when nothing else is missing", () => {
    expect(ask("message Kris on Teams saying hi")).toBe("Which Kris: Chris Lee or Krzysztof Nowak?");
    expect(ask("open kris's chat")).toBe("Which Kris: Chris Lee or Krzysztof Nowak?");
  });
});
