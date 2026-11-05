import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MemoryFactList, memoryClearMessage, memoryDateLabel, newestFirst } from "./MemoryFactList";

const facts = [
  { text: "Prefers British English", kind: "preference" as const, updated: "2026-11-01" },
  { text: "Sam in Teams is Samuel Jones", kind: "person" as const, updated: "2026-11-05" },
];

describe("Saved memory list", () => {
  it("shows dates as day month year, and leaves an odd one as it is", () => {
    expect(memoryDateLabel("2026-11-05")).toBe("5 November 2026");
    expect(memoryDateLabel("2026-13-05")).toBe("2026-13-05");
    expect(memoryDateLabel("")).toBe("");
  });

  it("lists the newest first, with kind and date", () => {
    expect(newestFirst(facts).map((fact) => fact.text)).toEqual(["Sam in Teams is Samuel Jones", "Prefers British English"]);
    const markup = renderToStaticMarkup(createElement(MemoryFactList, { facts }));
    expect(markup.indexOf("Samuel Jones")).toBeLessThan(markup.indexOf("British English"));
    expect(markup).toContain("Person · 5 November 2026");
    expect(markup).toContain("Preference · 1 November 2026");
  });

  it("says so when nothing is saved", () => {
    expect(renderToStaticMarkup(createElement(MemoryFactList, { facts: [] }))).toContain("Nothing saved yet");
  });

  it("words the clear result by count", () => {
    expect(memoryClearMessage(0)).toBe("Nothing saved to clear.");
    expect(memoryClearMessage(1)).toBe("Cleared 1 saved fact.");
    expect(memoryClearMessage(3)).toBe("Cleared 3 saved facts.");
  });
});
