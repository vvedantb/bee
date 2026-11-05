import { describe, expect, it } from "vitest";
import { KNOWN_NAMES_MAX, knownNamesBlock, mergeNames, normalizeNames, screenNames, spelledName } from "./known-names";

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
