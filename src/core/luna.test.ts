import { describe, expect, it } from "vitest";
import { LUNA_SYSTEM, buildLunaPrompt, parseLunaTips } from "./luna";

describe("buildLunaPrompt", () => {
  it("includes the recent transcript and numbered notes", () => {
    const { system, prompt } = buildLunaPrompt({
      transcript: ["  First line ", "Second line"],
      notes: [
        { id: "x.md#1", title: "Acme › Pricing", text: "10% discount" },
        { id: "y.md#0", title: "Habits", text: "Summarise decisions" },
      ],
    });
    expect(system).toBe(LUNA_SYSTEM);
    expect(prompt).toContain("- First line\n- Second line");
    expect(prompt).toContain("[n1] Acme › Pricing\n10% discount");
    expect(prompt).toContain("[n2] Habits\nSummarise decisions");
    expect(prompt.endsWith("Tips:")).toBe(true);
  });

  it("keeps only the last 8 transcript lines and marks missing notes", () => {
    const transcript = Array.from({ length: 12 }, (_, index) => `line ${index}`);
    const { prompt } = buildLunaPrompt({ transcript, notes: [] });
    expect(prompt).not.toContain("line 3");
    expect(prompt).toContain("line 4");
    expect(prompt).toContain("line 11");
    expect(prompt).toContain("Relevant notes:\n(none)");
  });
});

describe("LUNA_SYSTEM", () => {
  it("lets tips answer direct questions from notes or general knowledge", () => {
    expect(LUNA_SYSTEM).toContain("direct question");
    expect(LUNA_SYSTEM).toContain("general knowledge");
    expect(LUNA_SYSTEM).toContain("at most 2 short tips");
  });
});

describe("parseLunaTips", () => {
  it("strips bullets and numbering and caps at two tips", () => {
    expect(parseLunaTips("- Offer 10% [n1]\n* Ask about timing\n3. Third")).toEqual(["Offer 10% [n1]", "Ask about timing"]);
  });

  it("treats NONE and blank output as no tips", () => {
    expect(parseLunaTips("NONE")).toEqual([]);
    expect(parseLunaTips("  \n ")).toEqual([]);
  });
});
