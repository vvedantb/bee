import { describe, expect, it } from "vitest";
import { LOOP_REPEATS, noProgress, stopOnNoProgress } from "./loop-guard";

const step = (id: string, toolName: string, input: unknown, output: unknown) => ({ toolCalls: [{ toolCallId: id, toolName, input }], toolResults: [{ toolCallId: id, output }] });

describe("noProgress", () => {
  it("trips on the same call with the same result three times in a row", () => {
    expect(LOOP_REPEATS).toBe(3);
    const same = (id: string) => step(id, "find", { app: "Teams", name: "Search" }, "No matches.");
    expect(noProgress([same("1"), same("2")])).toBe(false);
    expect(noProgress([same("1"), same("2"), same("3")])).toBe(true);
  });

  it("never trips when the input or the result changes, or another call comes between", () => {
    expect(noProgress([step("1", "find", { name: "a" }, "x"), step("2", "find", { name: "b" }, "x"), step("3", "find", { name: "a" }, "x")])).toBe(false);
    expect(noProgress([step("1", "scroll", { ref: "e1" }, "Now: 1"), step("2", "scroll", { ref: "e1" }, "Now: 2"), step("3", "scroll", { ref: "e1" }, "Now: 3")])).toBe(false);
    expect(noProgress([step("1", "list_apps", {}, "a"), step("2", "list_apps", {}, "a"), step("3", "snapshot", {}, "tree"), step("4", "list_apps", {}, "a")])).toBe(false);
  });

  it("counts calls inside one step too", () => {
    const calls = ["1", "2", "3"].map((id) => ({ toolCallId: id, toolName: "count", input: { table: "users" } }));
    const results = ["1", "2", "3"].map((id) => ({ toolCallId: id, output: 16 }));
    expect(noProgress([{ toolCalls: calls, toolResults: results }])).toBe(true);
  });
});

describe("stopOnNoProgress", () => {
  it("stops only on a loop, and reports it once", () => {
    let loops = 0;
    const stop = stopOnNoProgress(() => loops++);
    const same = (id: string) => step(id, "find", {}, "none");
    expect(stop({ steps: [same("1")] })).toBe(false);
    expect(stop({ steps: [same("1"), same("2"), same("3")] })).toBe(true);
    expect(stop({ steps: [same("1"), same("2"), same("3"), same("4")] })).toBe(true);
    expect(loops).toBe(1);
  });
});
