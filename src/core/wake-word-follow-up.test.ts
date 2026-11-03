import { describe, expect, it } from "vitest";
import {
  CONVERSATION_QUESTION_MS,
  CONVERSATION_WINDOW_MS,
  FOLLOW_UP_CONFIDENCE,
  WAKE_FOLLOW_MS,
  isConversationClose,
  isForBee,
  looksAddressedToBee,
  namesParticipant,
  routeLine,
  type LineSource,
} from "./wake-word";

// The conversation window after a request to Bee (owner logs, 3 Nov): "why do you not go to the team usage…" said without "Bee"
// right after "B, open Vercel usage" is a follow-up, not a meeting line. Only the user's own mic can reach Bee.

const lastBee = { request: "open Vercel usage", reply: "Opened https://vercel.com/acme/~/usage" };
const open = (text: string, extra: Partial<Parameters<typeof routeLine>[0]> = {}) =>
  routeLine({ text, source: "mic", enabled: true, conversationOpen: true, lastBee, ...extra });

describe("routeLine: the conversation window", () => {
  it("keeps the window and the wake follow-up separate", () => {
    expect(CONVERSATION_WINDOW_MS).toBe(60_000);
    expect(CONVERSATION_QUESTION_MS).toBe(120_000);
    expect(WAKE_FOLLOW_MS).toBe(8000);
  });

  it("routes a mic follow-up without Bee to the AI while the window is open", () => {
    for (const text of [
      "why do you not go to the team usage",
      "No, the team one",
      "that's wrong",
      "open the team usage",
      "go back to that page",
      "can you check the billing tab",
    ]) {
      expect(open(text), text).toMatchObject({ kind: "command", command: text, followUp: true });
    }
  });

  it("takes a phrase that points Bee at one of its connectors, even after someone else spoke", () => {
    for (const text of ["use the vmem connector", "search vmem", "and try it in vmem", "check the Eva connector", "ok, use the connectors", "look it up with the Notion connector"]) {
      expect(open(text), text).toMatchObject({ kind: "command", command: text, followUp: true, reason: "connector" });
      expect(open(text, { othersSpoke: true }), text).toMatchObject({ kind: "command", reason: "connector" });
    }
  });

  it("never takes a person named Eva, or connector talk without the window, for a connector", () => {
    expect(looksAddressedToBee("Eva said the budget is fine", lastBee)).not.toBe("connector");
    expect(routeLine({ text: "search vmem", source: "mic", enabled: true, lastBee })).toEqual({ kind: "meeting" });
  });

  it("takes a short answer when Bee's last reply asked a question", () => {
    const asked = { request: "open the team usage", reply: "Which team?" };
    expect(open("Acme platform", { lastBee: asked })).toMatchObject({ kind: "command", command: "Acme platform", reason: "answer" });
    expect(open("Acme platform", { lastBee })).toEqual({ kind: "unclear" });
  });

  it("leaves the same phrases in the meeting once the window is closed", () => {
    expect(routeLine({ text: "No, the team one", source: "mic", enabled: true, lastBee })).toEqual({ kind: "meeting" });
    expect(routeLine({ text: "why did you do that", source: "mic", enabled: true, conversationOpen: false, lastBee })).toEqual({ kind: "meeting" });
  });

  it("never routes other people's lines, even in the window", () => {
    const others: LineSource[] = ["typed", "caption", "teams-audio", "teammate"];
    for (const source of others) {
      for (const text of ["why did you open that page", "No, the team one", "thanks", "stop"]) {
        expect(routeLine({ text, source, enabled: true, conversationOpen: true, lastBee }), `${source}: ${text}`).toEqual({ kind: "meeting" });
      }
    }
  });

  it("does nothing with the setting off", () => {
    expect(routeLine({ text: "why did you open that page", source: "mic", enabled: false, conversationOpen: true, lastBee })).toEqual({ kind: "meeting" });
  });

  it("closes on thanks, and stops on stop", () => {
    for (const text of ["thanks", "Thank you.", "OK, thanks Bee", "that's all", "Great, that's it.", "cheers"]) expect(open(text), text).toEqual({ kind: "close" });
    for (const text of ["stop", "Stop it.", "never mind"]) expect(open(text), text).toEqual({ kind: "stop" });
    expect(open("Bee, stop")).toEqual({ kind: "stop" });
  });

  it("goes back to the meeting when the user names a participant", () => {
    expect(open("Priya, can you share the deck?", { participants: ["Priya Shah", "Sam"] })).toEqual({ kind: "meeting", reason: "names-participant" });
  });

  it("treats an unclear phrase as a reply to others once someone else spoke", () => {
    expect(open("I think we should ship it Friday", { othersSpoke: true })).toEqual({ kind: "meeting", reason: "reply-to-others" });
    // "you" after someone else spoke may be for them.
    expect(open("what do you think about Friday", { othersSpoke: true })).toEqual({ kind: "meeting", reason: "reply-to-others" });
    // A correction or a pointer at Bee's page is still for Bee.
    expect(open("No, the team one", { othersSpoke: true })).toMatchObject({ kind: "command", followUp: true });
  });

  it("calls a statement with no sign either way unclear, and filler a meeting line", () => {
    expect(open("So, about the renewal.")).toEqual({ kind: "unclear" });
    expect(open("um")).toEqual({ kind: "meeting", reason: "filler" });
  });

  it("still takes the wake word first", () => {
    expect(open("Bee, open Teams")).toEqual({ kind: "command", command: "open Teams" });
    expect(open("Bee.")).toEqual({ kind: "wake" });
  });
});

describe("looksAddressedToBee", () => {
  it("names the reason", () => {
    expect(looksAddressedToBee("why did you open that", lastBee)).toBe("second-person");
    expect(looksAddressedToBee("no, not that", lastBee)).toBe("correction");
    expect(looksAddressedToBee("open billing", lastBee)).toBe("instruction");
    expect(looksAddressedToBee("the other one", lastBee)).toBe("reference");
    expect(looksAddressedToBee("Revenue is up this quarter.", lastBee)).toBeNull();
    expect(looksAddressedToBee("", lastBee)).toBeNull();
    // A bare "no" answers only Bee's own question.
    expect(looksAddressedToBee("No.", lastBee)).toBeNull();
    expect(looksAddressedToBee("No.", { request: "send it", reply: "Send it to Sam?" })).toBe("answer");
  });
});

describe("isConversationClose", () => {
  it("is only the whole phrase", () => {
    expect(isConversationClose("thanks")).toBe(true);
    expect(isConversationClose("thanks, now open the team usage")).toBe(false);
    expect(isConversationClose("done with the deck?")).toBe(false);
  });
});

describe("namesParticipant", () => {
  it("matches a first name as a whole word, never Bee, Meeting or one letter", () => {
    expect(namesParticipant("ask Sam about it", ["Sam Lee"])).toBe("Sam Lee");
    expect(namesParticipant("same again", ["Sam Lee"])).toBeNull();
    expect(namesParticipant("Bee, open it", ["Bee", "Meeting", "A"])).toBeNull();
  });
});

describe("isForBee", () => {
  it("acts only on bee at the confidence bar", () => {
    expect(FOLLOW_UP_CONFIDENCE).toBe(0.7);
    expect(isForBee({ addressed: "bee", confidence: 0.7 })).toBe(true);
    expect(isForBee({ addressed: "bee", confidence: 0.69 })).toBe(false);
    expect(isForBee({ addressed: "meeting", confidence: 0.95 })).toBe(false);
    expect(isForBee(null)).toBe(false);
  });
});
