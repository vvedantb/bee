import { describe, expect, it } from "vitest";
import {
  KNOWN_NAMES_MAX, STT_TERMS_MAX, correctedName, knownNamesBlock, matchFirstName, mergeNames, nameAmbiguities, namesSoundingLike, normalizeNames, recentChoice, remapHeardNames, spellingSettled,
  screenNames, soundKey, soundsAlike, spelledName, sttTerms, whichNameQuestion,
} from "./known-names";

describe("known names", () => {
  it("learns a name the user spells out after a correction (0.3.36 log)", () => {
    expect(spelledName("Bro, you spelt it wrong. Like, why you, you spelt it wrong. It's Z U Z A N N A.")).toBe("Zuzanna");
    expect(spelledName("it's spelled Zuzanna Moody")).toBe("Zuzanna Moody");
    expect(spelledName("Spelt Z-U-Z-A-N-N-A")).toBe("Zuzanna");
  });

  it("never learns from letters the user only quotes, or from ordinary speech", () => {
    expect(spelledName("You spelled it wrong. It's in my recent chat and you said, you said A N N A.")).toBeNull();
    expect(spelledName("It's a good idea to ship on Friday")).toBeNull();
    expect(spelledName("open Teams")).toBeNull();
  });

  it("reads people's names from Teams chat titles and the AI's report, never the user's own or an app", () => {
    expect(screenNames('App "ms-teams.exe", window "Chat | Zuzanna Szczepaniak-Moody | Evalucom Consulting Limited | vedant@…"')).toEqual(["Zuzanna Szczepaniak-Moody"]);
    expect(screenNames("Bee found the chat with Zuzanna Szczepaniak-Moody and read today's messages.")).toEqual(["Zuzanna Szczepaniak-Moody"]);
    expect(screenNames('window "Chat | Vedant Bhopatrao (You) | Evalucom"')).toEqual([]);
    expect(screenNames('window "Search | Microsoft Teams"')).toEqual([]);
  });

  it("keeps one of each name, newest last, within the limit", () => {
    expect(normalizeNames(["  Zuzanna ", "zuzanna", "", "x".repeat(200), "Sam Lee"])).toEqual(["Zuzanna", "Sam Lee"]);
    expect(mergeNames(["Sam Lee"], ["Zuzanna", "SAM LEE"])).toEqual(["Sam Lee", "Zuzanna"]);
    const many = Array.from({ length: KNOWN_NAMES_MAX + 5 }, (_, index) => `Name${index}`);
    expect(normalizeNames(many)).toHaveLength(KNOWN_NAMES_MAX);
    expect(normalizeNames(many).at(-1)).toBe(`Name${KNOWN_NAMES_MAX + 4}`);
  });

  it("gives the AI the names, newest first, or nothing", () => {
    expect(knownNamesBlock([])).toBe("");
    expect(knownNamesBlock(["Sam Lee", "Zuzanna"])).toMatch(/: Zuzanna, Sam Lee\.$/);
  });
});

// Same-sound names. Fixture people only: two contacts whose first names sound alike once misheard (an English "Chris" and a
// Polish "Krzysztof", whose short form "Krzys" sounds near it), and a "Zuzanna" STT tends to hear as "Susannah".
const KNOWN = ["Chris Lee", "Krzysztof Nowak", "Zuzanna Szczepaniak-Moody", "Sam Lee"];

describe("same-pronunciation names", () => {
  it("keys names by sound with general rules, so misheard spellings meet", () => {
    expect(soundKey("Chris")).toBe(soundKey("Krzys"));
    expect(soundKey("Susannah")).toBe(soundKey("Zuzanna"));
    expect(soundKey("Sean")).not.toBe(soundKey("Zuzanna"));
    expect(soundKey("Sam")).not.toBe(soundKey("Susan"));
  });

  it("finds every known person a heard name could be, spelling first", () => {
    // Spelling wins: a name spelled like one person drops people who only sound like it.
    expect(namesSoundingLike("Chris", KNOWN)).toEqual(["Chris Lee"]);
    expect(namesSoundingLike("Krzys", KNOWN)).toEqual(["Krzysztof Nowak"]);
    expect(namesSoundingLike("Kris", KNOWN)).toEqual(["Chris Lee", "Krzysztof Nowak"]);
    expect(namesSoundingLike("Krzys", ["Chris Lee", "Krzysztof Nowak"])).toEqual(["Krzysztof Nowak"]);
    expect(namesSoundingLike("Chris", ["Chris Lee", "Krzysztof Nowak"])).toEqual(["Chris Lee"]);
    expect(namesSoundingLike("Susannah", KNOWN)).toEqual(["Zuzanna Szczepaniak-Moody"]);
    expect(namesSoundingLike("Sam", KNOWN)).toEqual(["Sam Lee"]);
  });

  it("calls a name ambiguous only when two or more people match and nothing in the request tells them apart", () => {
    expect(nameAmbiguities("send Kris a message saying hi", KNOWN)).toEqual([{ heard: "Kris", matches: ["Chris Lee", "Krzysztof Nowak"] }]);
    expect(nameAmbiguities("send Chris a message saying hi", KNOWN)).toEqual([]);
    expect(nameAmbiguities("send Chris Lee a message", KNOWN)).toEqual([]);
    expect(nameAmbiguities("send Krzysztof Nowak the notes", KNOWN)).toEqual([]);
    expect(nameAmbiguities("send Susannah the notes", KNOWN)).toEqual([]);
    // With only one Chris taught, there is nothing to ask.
    expect(nameAmbiguities("send Chris hi", ["Chris Lee", "Sam Lee"])).toEqual([]);
    expect(whichNameQuestion({ heard: "Chris", matches: ["Chris Lee", "Krzysztof Nowak"] })).toBe("Which Chris: Chris Lee or Krzysztof Nowak?");
  });

  it("never maps one name to another for good: the same request asks again with the same people known", () => {
    const first = nameAmbiguities("message Kris", KNOWN);
    const learned = mergeNames(KNOWN, ["Krzysztof"]);
    expect(first.map((item) => item.heard)).toEqual(["Kris"]);
    expect(nameAmbiguities("message Kris", learned).map((item) => item.heard)).toEqual(first.map((item) => item.heard));
    expect(knownNamesBlock(KNOWN, "message Kris")).toMatch(/"Kris" in this request could be .*Krzysztof Nowak.*Chris Lee|"Kris" in this request could be .*Chris Lee.*Krzysztof Nowak/);
    expect(knownNamesBlock(KNOWN, "message Kris")).toContain("never pick one yourself");
    expect(knownNamesBlock(KNOWN, "message Sam")).not.toContain("in this request could be");
  });
});

describe("name corrections", () => {
  it("learns the name the user corrects Bee to", () => {
    expect(correctedName("No, I meant Krzysztof.")).toBe("Krzysztof");
    expect(correctedName("not Chris, Krzysztof")).toBe("Krzysztof");
    expect(correctedName("Krzysztof Nowak, not Chris")).toBe("Krzysztof Nowak");
    expect(correctedName("it's Krzysztof not Chris")).toBe("Krzysztof");
  });

  it("never learns from a correction that names no person", () => {
    expect(correctedName("I mean the team one")).toBeNull();
    expect(correctedName("not that, the other")).toBeNull();
    expect(correctedName("Chris, not that one")).toBeNull();
    expect(correctedName("open Chrome")).toBeNull();
  });
});

describe("names that are not the same sound (PR #80 review)", () => {
  it("no longer matches a name by a crude prefix of its sound key", () => {
    expect(soundsAlike("John", "Joan")).toBe(false);
    expect(matchFirstName("Alex", "Alexandra")).toBe("short");
    expect(matchFirstName("Max", "Maxwell")).toBe("short");
    expect(matchFirstName("John", "Joan")).toBeNull();
    // Said the same: one sound, two spellings.
    expect(soundsAlike("Sara", "Sarah")).toBe(true);
    expect(soundsAlike("Chris", "Krzys")).toBe(true);
    expect(soundsAlike("Susannah", "Zuzanna")).toBe(true);
    expect(matchFirstName("Chris", "Krzysztof")).toBe("sound-short");
  });

  it("never asks between a name and a longer name that only starts with it", () => {
    expect(nameAmbiguities("send Alex hi", ["Alex Smith", "Alexandra Jones"])).toEqual([]);
    expect(namesSoundingLike("Alex", ["Alex Smith", "Alexandra Jones"])).toEqual(["Alex Smith"]);
    expect(nameAmbiguities("send Alexandra hi", ["Alex Smith", "Alexandra Jones"])).toEqual([]);
    expect(nameAmbiguities("message Max", ["Max Hall", "Maxwell Ode"])).toEqual([]);
    expect(nameAmbiguities("call John", ["John Park", "Joan Reed"])).toEqual([]);
    expect(nameAmbiguities("call Joan", ["John Park", "Joan Reed"])).toEqual([]);
  });

  it("still asks for names said the same way, which the user's voice cannot tell apart", () => {
    // Sara and Sarah are one sound: with both known, asking is right.
    expect(nameAmbiguities("send Sara the notes", ["Sara Kim", "Sarah Ode"])).toEqual([{ heard: "Sara", matches: ["Sara Kim", "Sarah Ode"] }]);
    // Two people only known by a short form they both start with: asking is right too.
    expect(nameAmbiguities("send Alex hi", ["Alexandra Jones", "Alexander Brown"])).toEqual([{ heard: "Alex", matches: ["Alexandra Jones", "Alexander Brown"] }]);
  });

  it("treats a one-word name inside a fuller known name as the same person", () => {
    expect(namesSoundingLike("Krzysztof", ["Krzysztof", "Krzysztof Nowak"])).toEqual(["Krzysztof Nowak"]);
  });
});

describe("which person, in more kinds of request (PR #80 review)", () => {
  it("asks for open, find, call, a possessive chat and lower-case speech-to-text", () => {
    for (const request of ["open kris's chat", "find kris", "call kris", "send kris a message", "Open Kris’s DM", "chat with kris", "send a message to kris"]) {
      const [first] = nameAmbiguities(request, KNOWN);
      expect(first?.matches, request).toEqual(["Chris Lee", "Krzysztof Nowak"]);
    }
    expect(whichNameQuestion(nameAmbiguities("find kris", KNOWN)[0]!)).toBe("Which Kris: Chris Lee or Krzysztof Nowak?");
  });

  it("never asks about an app or an ordinary word", () => {
    for (const request of ["open Chrome", "open chrome", "open teams", "send the same message", "find the file", "call me later"]) {
      expect(nameAmbiguities(request, [...KNOWN, "Sam Lee", "Sam Hill"]), request).toEqual([]);
    }
  });
});

describe("a person from recent requests", () => {
  const unclear = { heard: "Kris", matches: ["Chris Lee", "Krzysztof Nowak"] };

  it("prefers the one person the newest recent text names, without asking", () => {
    expect(recentChoice(unclear, ["send Chris Lee the deck", "Sent the deck to Krzysztof Nowak."])).toBe("Krzysztof Nowak");
    expect(recentChoice(unclear, ["Opened the chat with Chris Lee."])).toBe("Chris Lee");
    expect(recentChoice(unclear, ["message Nowak about lunch"])).toBe("Krzysztof Nowak");
  });

  it("asks when the newest mention names both, or nothing recent names either", () => {
    expect(recentChoice(unclear, ["Sent the deck to Krzysztof Nowak.", "Which Kris: Chris Lee or Krzysztof Nowak?"])).toBeNull();
    expect(recentChoice(unclear, ["what's the weather?"])).toBeNull();
    // The heard word alone tells nothing.
    expect(recentChoice(unclear, ["send Kris hi"])).toBeNull();
  });

  it("tells the AI who was meant instead of asking it to ask", () => {
    const block = knownNamesBlock(KNOWN, "message Kris", [{ heard: "Kris", name: "Krzysztof Nowak" }]);
    expect(block).toContain('"Kris" in this request means Krzysztof Nowak');
    expect(block).not.toContain("never pick one yourself");
  });
});

describe("spelling wins over sound (PR #80 e2e B and G)", () => {
  const known = ["Chris Lee", "Krzysztof Nowak"];

  it("drops sound-alike rivals of a spelling match, so Krzys and Chris are never asked about", () => {
    expect(namesSoundingLike("Krzys", known)).toEqual(["Krzysztof Nowak"]);
    expect(namesSoundingLike("Chris", known)).toEqual(["Chris Lee"]);
    expect(nameAmbiguities("type hi Krzys in the message box", known)).toEqual([]);
    expect(nameAmbiguities("message Krzys", known)).toEqual([]);
    expect(nameAmbiguities("message Chris", known)).toEqual([]);
    // Recent text naming Chris Lee cannot turn Krzys back into Chris: there is no ambiguity for it to settle.
    expect(nameAmbiguities("send krzys hi", known)).toEqual([]);
  });

  it("tells the AI which person spelling settled, and never asks it to choose", () => {
    expect(spellingSettled("type hi Krzys in the message box", known)).toEqual([{ heard: "Krzys", name: "Krzysztof Nowak" }]);
    expect(spellingSettled("message Chris", known)).toEqual([{ heard: "Chris", name: "Chris Lee" }]);
    // One person matching in any way needs no line.
    expect(spellingSettled("message Chris", ["Chris Lee", "Sam Lee"])).toEqual([]);
    const block = knownNamesBlock(known, "type hi Krzys in the message box");
    expect(block).toContain('"Krzys" in this request means Krzysztof Nowak');
    expect(block).not.toContain("in this request could be");
  });

  it("still asks for a genuine tie: a name that only sounds like both, or is spelled like both", () => {
    expect(nameAmbiguities("message Kris", known)).toEqual([{ heard: "Kris", matches: ["Chris Lee", "Krzysztof Nowak"] }]);
    expect(nameAmbiguities("send Sara the notes", ["Sara Kim", "Sarah Ode"])).toEqual([{ heard: "Sara", matches: ["Sara Kim", "Sarah Ode"] }]);
    expect(nameAmbiguities("send Sarah the notes", ["Sara Kim", "Sarah Ode"])).toEqual([{ heard: "Sarah", matches: ["Sara Kim", "Sarah Ode"] }]);
    expect(nameAmbiguities("message Sam", ["Sam Lee", "Sam Hill"])).toEqual([{ heard: "Sam", matches: ["Sam Lee", "Sam Hill"] }]);
  });
});

describe("misheard names after speech-to-text", () => {
  it("puts a misheard name in the one known spelling it sounds like", () => {
    expect(remapHeardNames("Bee, send Susannah the notes.", ["Zuzanna Szczepaniak-Moody"])).toEqual({ text: "Bee, send Zuzanna the notes.", changes: [{ from: "Susannah", to: "Zuzanna" }] });
    expect(remapHeardNames("Bee, send Chris a message.", ["Krzysztof Nowak"]).text).toBe("Bee, send Krzysztof a message.");
    expect(remapHeardNames("Bee, open chris's chat", ["Krzysztof Nowak"]).text).toBe("Bee, open Krzysztof's chat");
  });

  it("leaves a name alone when two known people could be it, or it is already a known spelling", () => {
    const both = ["Chris Lee", "Krzysztof Nowak"];
    expect(remapHeardNames("Bee, send Chris a message.", both)).toEqual({ text: "Bee, send Chris a message.", changes: [] });
    // Krzys sounds like Chris Lee and starts Krzysztof: two people, so it stays.
    expect(remapHeardNames("Bee, send Krzys a message.", both).text).toBe("Bee, send Krzys a message.");
    expect(remapHeardNames("Bee, send Chris a message.", ["Chris Lee"]).changes).toEqual([]);
  });

  it("never changes a literal short form or an ordinary word", () => {
    expect(remapHeardNames("send Alex the file", ["Alexandra Jones"]).text).toBe("send Alex the file");
    expect(remapHeardNames("Same here, send the same file.", ["Sam Lee"]).text).toBe("Same here, send the same file.");
    expect(remapHeardNames("Well, it is done.", ["Will Smith", "Dan Ode"]).text).toBe("Well, it is done.");
    expect(remapHeardNames("send John the file", ["Joan Reed"]).text).toBe("send John the file");
    expect(remapHeardNames("anything", []).changes).toEqual([]);
    // An app the caller names stays as heard, whatever person it sounds like.
    expect(remapHeardNames("Bee, open Chris", ["Krzysztof Nowak"]).text).toBe("Bee, open Krzysztof");
    expect(remapHeardNames("Bee, open Chris", ["Krzysztof Nowak"], { skip: (word) => word === "Chris" }).text).toBe("Bee, open Chris");
  });

  it("gives speech-to-text the names, newest first, then first names, within a cap", () => {
    expect(sttTerms(["Chris Lee", "Krzysztof Nowak"])).toEqual(["Krzysztof Nowak", "Chris Lee", "Krzysztof", "Chris"]);
    expect(sttTerms(Array.from({ length: 80 }, (_, index) => `Name${index} Lee`))).toHaveLength(STT_TERMS_MAX);
    expect(sttTerms([])).toEqual([]);
  });
});
