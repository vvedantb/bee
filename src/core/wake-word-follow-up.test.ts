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
  replyInvitesAnswer,
  routeLine,
  type LineSource,
} from "./wake-word";

// The conversation window after a request to Bee (owner logs, 3 Nov): "why do you not go to the team usage…" said without "Bee"
// right after "B, open Vercel usage" is a follow-up, not a meeting line. Only the user's own mic can reach Bee.

const lastBee = { request: "open Vercel usage", reply: "Opened https://vercel.com/acme/~/usage" };
const open = (text: string, extra: Partial<Parameters<typeof routeLine>[0]> = {}) =>
  routeLine({ text, source: "mic", conversationOpen: true, lastBee, ...extra });

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
    expect(routeLine({ text: "search vmem", source: "mic", lastBee })).toEqual({ kind: "meeting" });
  });

  it("takes a short answer when Bee's last reply asked a question", () => {
    const asked = { request: "open the team usage", reply: "Which team?" };
    expect(open("Acme platform", { lastBee: asked })).toMatchObject({ kind: "command", command: "Acme platform", reason: "answer" });
    expect(open("Acme platform", { lastBee })).toEqual({ kind: "unclear" });
  });

  it("leaves the same phrases in the meeting once the window is closed", () => {
    expect(routeLine({ text: "No, the team one", source: "mic", lastBee })).toEqual({ kind: "meeting" });
    expect(routeLine({ text: "why did you do that", source: "mic", conversationOpen: false, lastBee })).toEqual({ kind: "meeting" });
  });

  it("never routes other people's lines, even in the window", () => {
    const others: LineSource[] = ["typed", "caption", "teams-audio", "teammate"];
    for (const source of others) {
      for (const text of ["why did you open that page", "No, the team one", "thanks", "stop"]) {
        expect(routeLine({ text, source, conversationOpen: true, lastBee }), `${source}: ${text}`).toEqual({ kind: "meeting" });
      }
    }
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

// Owner log (0.3.36): "Yes, I do." after "…say if you want those counted too" went to the meeting as filler.
describe("routeLine: yes or no to Bee's question or offer", () => {
  const offered = {
    request: "how many users does Eva have",
    reply: "Eva has 16 users in the production web app's users table. Bee only counted Eva itself. CarePulse and vmem keep separate user data, so say if you want those counted too.",
  };
  const asked = { request: "make a task", reply: "Which repo should the task go in, bee or eva?" };
  const canAlso = { request: "count users", reply: "Bee can also count CarePulse, vmem or staging if you want." };

  it("finds offers as well as questions", () => {
    expect(replyInvitesAnswer(offered.reply)).toBe(true);
    expect(replyInvitesAnswer(asked.reply)).toBe(true);
    expect(replyInvitesAnswer(canAlso.reply)).toBe(true);
    for (const reply of ["Say the word and Bee will send it.", "Want Bee to open it", "Shall Bee book it.", "Would you like the full list."]) {
      expect(replyInvitesAnswer(reply), reply).toBe(true);
    }
    expect(replyInvitesAnswer(lastBee.reply)).toBe(false);
    expect(replyInvitesAnswer("Opened Teams.")).toBe(false);
    expect(replyInvitesAnswer(null)).toBe(false);
  });

  it("takes a short yes or no as an answer", () => {
    const answers = ["Yes.", "Yes, I do.", "Yes, can we do that?", "yeah", "yep", "sure", "ok do it", "go ahead", "do it", "please do", "no", "nope"];
    for (const bee of [offered, asked, canAlso]) {
      for (const text of answers) {
        expect(open(text, { lastBee: bee }), `${bee.reply}: ${text}`).toMatchObject({ kind: "command", command: text, followUp: true });
      }
    }
    expect(open("Yes, I do.", { lastBee: offered })).toMatchObject({ reason: "answer" });
    expect(open("Yes.", { lastBee: asked })).toMatchObject({ reason: "answer" });
  });

  it("never reads okay or please alone as yes to an offer", () => {
    for (const text of ["Okay, let's move on to the budget item.", "Okay so the numbers look fine to me"]) {
      expect(open(text, { lastBee: offered }), text).not.toMatchObject({ kind: "command", reason: "answer" });
    }
  });

  it("still closes on thanks, no thanks included", () => {
    for (const text of ["no thanks", "No, thank you.", "nope, thanks", "Okay, thanks."]) expect(open(text, { lastBee: offered }), text).toEqual({ kind: "close" });
  });

  it("leaves yes and no in the meeting when Bee neither asked nor offered", () => {
    for (const text of ["Yes.", "Yes, I do.", "yeah", "sure", "No."]) {
      expect(open(text), text).toMatchObject({ kind: "meeting" });
    }
  });

  it("calls yes or no a reply to others once someone else spoke", () => {
    for (const text of ["Yes.", "Yes, I do.", "nope"]) {
      expect(open(text, { lastBee: offered, othersSpoke: true }), text).toEqual({ kind: "meeting", reason: "reply-to-others" });
    }
  });

  it("keeps a correction strong after someone else spoke", () => {
    expect(open("No, the team one", { lastBee: asked, othersSpoke: true })).toMatchObject({ kind: "command", reason: "correction" });
  });
});
