import { describe, expect, it } from "vitest";
import { lunaActivitySchema } from "./ipc";

describe("lunaActivitySchema", () => {
  it("takes a tool call's start and end, with or without the run id", () => {
    expect(lunaActivitySchema.parse({ runId: 3, tool: "web_search", phase: "start" })).toEqual({ runId: 3, tool: "web_search", phase: "start" });
    expect(lunaActivitySchema.parse({ tool: "read_file", phase: "end" })).toEqual({ tool: "read_file", phase: "end" });
  });

  it("rejects a missing or unknown phase and an overlong tool name", () => {
    expect(lunaActivitySchema.safeParse({ tool: "web_search" }).success).toBe(false);
    expect(lunaActivitySchema.safeParse({ tool: "web_search", phase: "done" }).success).toBe(false);
    expect(lunaActivitySchema.safeParse({ tool: "x".repeat(81), phase: "start" }).success).toBe(false);
  });
});
