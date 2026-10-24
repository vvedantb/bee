import { describe, expect, it } from "vitest";
import { TIP_MAX_CHARS, clampTip, lunaActivitySchema, lunaPartialSchema, meetingSummaryRequestSchema, pipelineRequestSchema, pipelineResultSchema } from "./ipc";

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

describe("tip limits", () => {
  // A full-text answer: longer than the old 500-character limit that failed the next turn's IPC.
  const long = "The District line closure is planned engineering work. ".repeat(14);

  it("accepts a long real tip wherever tips cross IPC", () => {
    expect(long.length).toBeGreaterThan(500);
    const base = { transcript: ["why"], sessionToken: "t" };
    expect(pipelineRequestSchema.safeParse({ ...base, earlier: ["Short", long] }).success).toBe(true);
    expect(pipelineRequestSchema.safeParse({ ...base, shown: [long] }).success).toBe(true);
    expect(lunaPartialSchema.safeParse({ tips: [long] }).success).toBe(true);
    expect(meetingSummaryRequestSchema.safeParse({ ...base, notesCited: [], tips: [long] }).success).toBe(true);
    const result = { notes: [], rankSource: "fallback", rankError: null, tips: [long], sources: [], guideError: null };
    const timingsMs = { retrieve: 0, rank: 0, guide: 0, mcp: 0, lunaFirstToken: null, lunaTotal: 0 };
    expect(pipelineResultSchema.safeParse({ ...result, timingsMs }).success).toBe(true);
  });

  it("stays bounded, and clampTip brings any tip within it", () => {
    const over = "x".repeat(TIP_MAX_CHARS + 1);
    expect(pipelineRequestSchema.safeParse({ transcript: ["a"], sessionToken: "t", earlier: [over] }).success).toBe(false);
    expect(clampTip(over)).toHaveLength(TIP_MAX_CHARS);
    expect(clampTip(long)).toBe(long);
    expect(pipelineRequestSchema.safeParse({ transcript: ["a"], sessionToken: "t", earlier: [clampTip(over)] }).success).toBe(true);
  });
});
