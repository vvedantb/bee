import { describe, expect, it } from "vitest";
import {
  KNOWN_NAMES_MAX, correctedName, knownNamesBlock, mergeNames, nameAmbiguities, namesSoundingLike, normalizeNames, screenNames, soundKey, spelledName, whichNameQuestion,
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

  it("finds every known person a heard name could be", () => {
    expect(namesSoundingLike("Chris", KNOWN)).toEqual(["Chris Lee", "Krzysztof Nowak"]);
    expect(namesSoundingLike("Krzys", KNOWN)).toEqual(["Chris Lee", "Krzysztof Nowak"]);
    expect(namesSoundingLike("Susannah", KNOWN)).toEqual(["Zuzanna Szczepaniak-Moody"]);
    expect(namesSoundingLike("Sam", KNOWN)).toEqual(["Sam Lee"]);
  });

  it("calls a name ambiguous only when two or more people match and nothing in the request tells them apart", () => {
    expect(nameAmbiguities("send Chris a message saying hi", KNOWN)).toEqual([{ heard: "Chris", matches: ["Chris Lee", "Krzysztof Nowak"] }]);
    expect(nameAmbiguities("send Chris Lee a message", KNOWN)).toEqual([]);
    expect(nameAmbiguities("send Krzysztof Nowak the notes", KNOWN)).toEqual([]);
    expect(nameAmbiguities("send Susannah the notes", KNOWN)).toEqual([]);
    // With only one Chris taught, there is nothing to ask.
    expect(nameAmbiguities("send Chris hi", ["Chris Lee", "Sam Lee"])).toEqual([]);
    expect(whichNameQuestion({ heard: "Chris", matches: ["Chris Lee", "Krzysztof Nowak"] })).toBe("Which Chris: Chris Lee or Krzysztof Nowak?");
  });

  it("never maps one name to another for good: the same request asks again with the same people known", () => {
    const first = nameAmbiguities("message Chris", KNOWN);
    const learned = mergeNames(KNOWN, ["Krzysztof"]);
    expect(nameAmbiguities("message Chris", learned).map((item) => item.heard)).toEqual(first.map((item) => item.heard));
    expect(knownNamesBlock(KNOWN, "message Chris")).toMatch(/"Chris" in this request could be .*Krzysztof Nowak.*Chris Lee|"Chris" in this request could be .*Chris Lee.*Krzysztof Nowak/);
    expect(knownNamesBlock(KNOWN, "message Chris")).toContain("never pick one yourself");
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
