import { describe, expect, it } from "vitest";
import { REOPEN_WINDOW_MS, isConfirmWords, isReopenCommand, isStopCommand, routeLine, wakeCommand, type LineSource } from "./wake-word";

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
    expect(routeLine({ text: "Bee open Teams", source: "mic" })).toEqual({ kind: "command", command: "open Teams" });
    expect(routeLine({ text: "Hey Bee, what's 15% of 18000?", source: "mic" })).toEqual({ kind: "command", command: "what's 15% of 18000?" });
  });

  it("keeps other mic phrases in the meeting", () => {
    expect(routeLine({ text: "Let's pick up the Acme renewal.", source: "mic" })).toEqual({ kind: "meeting" });
    expect(routeLine({ text: "maybe later", source: "mic" })).toEqual({ kind: "meeting" });
  });

  it("never wakes on typed lines, captions, Teams audio or teammates' lines", () => {
    for (const source of sources) {
      expect(routeLine({ text: "Bee open Teams", source }), source).toEqual({ kind: "meeting" });
      expect(routeLine({ text: "Bee.", source }), source).toEqual({ kind: "meeting" });
      expect(routeLine({ text: "open Teams", source, armed: true }), source).toEqual({ kind: "meeting" });
    }
  });

  it("arms on Bee alone, and takes the next mic phrase as the request", () => {
    expect(routeLine({ text: "Bee.", source: "mic" })).toEqual({ kind: "wake" });
    expect(routeLine({ text: "Open Teams.", source: "mic", armed: true })).toEqual({ kind: "command", command: "Open Teams." });
    // A second wake word in the follow-up is stripped like any other.
    expect(routeLine({ text: "Bee, open Teams", source: "mic", armed: true })).toEqual({ kind: "command", command: "open Teams" });
    // Filler is not a request.
    expect(routeLine({ text: "um", source: "mic", armed: true })).toEqual({ kind: "meeting" });
  });
});

describe("isStopCommand", () => {
  it("is stop, cancel or never mind on its own", () => {
    for (const command of ["stop", "Stop.", "stop!", "stop it", "stop now", "please stop", "no, stop", "Cancel that.", "never mind", "nevermind", "abort"]) {
      expect(isStopCommand(command), command).toBe(true);
    }
  });

  it("is not a request that happens to start with stop or cancel", () => {
    for (const command of ["stop the music", "stop sharing my screen", "cancel my 3pm", "open Teams", "don't stop"]) expect(isStopCommand(command), command).toBe(false);
  });
});

describe("isConfirmWords", () => {
  it("is only a yes to a prompt", () => {
    for (const command of ["confirm", "yes", "Yes, send it.", "ok go ahead", "do it please"]) expect(isConfirmWords(command), command).toBe(true);
    for (const command of ["yes and also message Priya", "send it to Sam instead", "open Teams", "stop"]) expect(isConfirmWords(command), command).toBe(false);
  });
});

describe("routeLine: who can start or stop computer use", () => {
  const OTHERS: LineSource[] = ["typed", "caption", "teams-audio", "teammate"];

  it("stops on \"Bee, stop\" from the user's own mic, also after Bee alone", () => {
    for (const text of ["Bee, stop", "Bee stop.", "Hey Bee, cancel that", "B, stop!", "Be stop"]) expect(routeLine({ text, source: "mic" }), text).toEqual({ kind: "stop" });
    expect(routeLine({ text: "Stop.", source: "mic", armed: true })).toEqual({ kind: "stop" });
    // A plain "stop" in the meeting is just speech.
    expect(routeLine({ text: "Stop.", source: "mic" })).toEqual({ kind: "meeting" });
  });

  it("starts a task on screen only from the user's own mic", () => {
    const task = "Bee, open Discord, send Sam a message, then close the Discord tab in Chrome";
    expect(routeLine({ text: task, source: "mic" })).toEqual({ kind: "command", command: "open Discord, send Sam a message, then close the Discord tab in Chrome" });
    for (const source of OTHERS) expect(routeLine({ text: task, source }), source).toEqual({ kind: "meeting" });
  });

  it("never lets typed lines, captions, Teams audio or teammates stop or confirm anything", () => {
    for (const source of OTHERS) {
      for (const text of ["Bee, stop", "Bee, cancel", "Bee, confirm", "Bee, yes, send it", "stop"]) {
        expect(routeLine({ text, source }), `${source}: ${text}`).toEqual({ kind: "meeting" });
        expect(routeLine({ text, source, armed: true }), `${source}: ${text}`).toEqual({ kind: "meeting" });
      }
    }
  });

  it("has no spoken Confirm: \"Bee, confirm\" is a request, never an answer to a prompt", () => {
    expect(routeLine({ text: "Bee, confirm", source: "mic" })).toEqual({ kind: "command", command: "confirm" });
  });
});

// Owner log (0.3.36): after "Okay, thanks." closed the window, "Open teams." and "I said open teams." went to the meeting.
describe("routeLine: reopen just after the window closed", () => {
  const closed = (text: string, extra: Partial<Parameters<typeof routeLine>[0]> = {}) =>
    routeLine({ text, source: "mic", recentlyClosed: true, ...extra });

  it("is under a minute", () => {
    expect(REOPEN_WINDOW_MS).toBeGreaterThanOrEqual(45_000);
    expect(REOPEN_WINDOW_MS).toBeLessThanOrEqual(60_000);
  });

  it("takes a clear desktop request without Bee", () => {
    for (const text of [
      "open Teams",
      "Open teams.",
      "Can you open the Teams app please",
      "Can you open the Teams app please and",
      "I said open teams.",
      "please open Slack",
      "just launch Outlook",
      "switch to Chrome",
      "bring up the calendar",
      "close Spotify",
    ]) {
      expect(closed(text), text).toEqual({ kind: "command", command: text, followUp: true, reason: "reopen" });
    }
  });

  it("leaves meeting talk in the meeting", () => {
    for (const text of [
      "we should open the doc later",
      "open question about the budget",
      "let's open with the agenda",
      "Can we start with the numbers",
      "start by reviewing the forecast",
      "I'm open to ideas",
      "Can you share the deck?",
      "so what do you think about Friday",
      "open the floor to questions from the team and anyone else who joined late today",
    ]) {
      expect(closed(text), text).toEqual({ kind: "meeting" });
    }
    expect(closed("can you open the doc Sam", { participants: ["Sam Lee"] })).toEqual({ kind: "meeting" });
  });

  it("needs the recent close, the user's mic and nobody else speaking", () => {
    expect(routeLine({ text: "open Teams", source: "mic" })).toEqual({ kind: "meeting" });
    expect(closed("open Teams", { othersSpoke: true })).toEqual({ kind: "meeting" });
    expect(closed("open Teams", { source: "caption" })).toEqual({ kind: "meeting" });
  });

  it("isReopenCommand is short and verb-first", () => {
    expect(isReopenCommand("Open teams.")).toBe(true);
    expect(isReopenCommand("open question about the budget")).toBe(false);
    expect(isReopenCommand("open the Teams app and then the Outlook app and then the calendar please")).toBe(false);
  });
});
