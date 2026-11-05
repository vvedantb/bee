import { describe, expect, it, vi } from "vitest";
import { inMemoryBeeMemory, memorySummary } from "../core/bee-memory";

vi.mock("electron", () => ({ ipcMain: { handle: () => undefined } }));
vi.mock("./auth", () => ({
  assertSignedIn: (token: string) => {
    if (token !== "signed-in") throw new Error("Sign in to Bee to get guidance.");
  },
}));

const { beeMemoryHandlers } = await import("./bee-memory-ipc");

const NOW = () => new Date(2026, 10, 5);

describe("Saved memory IPC", () => {
  it("lists the facts oldest first, then clears them for the next request's summary", () => {
    const memory = inMemoryBeeMemory([], NOW);
    memory.write({ fact: "Prefers British English", kind: "preference" });
    memory.write({ fact: "Uses the new Outlook", kind: "app" });
    const handlers = beeMemoryHandlers(memory);
    expect(handlers.list({ sessionToken: "signed-in" }).facts.map((fact) => fact.text)).toEqual(["Prefers British English", "Uses the new Outlook"]);
    expect(memorySummary(memory.facts())).toContain("Uses the new Outlook");
    expect(handlers.clear({ sessionToken: "signed-in" })).toEqual({ cleared: 2 });
    expect(handlers.list({ sessionToken: "signed-in" })).toEqual({ facts: [] });
    expect(memorySummary(memory.facts())).toBe("");
  });

  it("refuses without a session, and clears nothing", () => {
    const memory = inMemoryBeeMemory([{ text: "Prefers tea", kind: "preference", updated: "2026-11-05" }]);
    const handlers = beeMemoryHandlers(memory);
    expect(() => handlers.list({ sessionToken: "" })).toThrow(/Sign in/);
    expect(() => handlers.clear({ sessionToken: "other" })).toThrow(/Sign in/);
    expect(() => handlers.clear({})).toThrow();
    expect(memory.facts()).toHaveLength(1);
  });
});
