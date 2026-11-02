import { describe, expect, it } from "vitest";
import {
  COMMAND_MAX_CHARS,
  COMPUTER_LINE_MAX,
  TIP_MAX_CHARS,
  clampTip,
  commandRequestSchema,
  commandStopSchema,
  computerAccessSchema,
  computerAnswerSchema,
  computerUpdateSchema,
  lunaActivitySchema,
  lunaPartialSchema,
  meetingSummaryRequestSchema,
  pipelineRequestSchema,
  pipelineResultSchema,
} from "./ipc";

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

describe("commandRequestSchema", () => {
  it("takes a trimmed request, optional background lines and a run id", () => {
    expect(commandRequestSchema.parse({ command: "  open Teams ", runId: 3, sessionToken: "t" })).toEqual({ command: "open Teams", runId: 3, sessionToken: "t" });
    expect(commandRequestSchema.parse({ command: "what did Priya ask?", transcript: ["Priya: Can we ship Friday?"], sessionToken: "t" }).transcript).toEqual(["Priya: Can we ship Friday?"]);
  });

  it("refuses an empty or overlong request, too many lines, and no session token", () => {
    expect(() => commandRequestSchema.parse({ command: "   ", sessionToken: "t" })).toThrow();
    expect(() => commandRequestSchema.parse({ command: "x".repeat(COMMAND_MAX_CHARS + 1), sessionToken: "t" })).toThrow();
    expect(() => commandRequestSchema.parse({ command: "open Teams", transcript: Array(9).fill("line"), sessionToken: "t" })).toThrow();
    expect(() => commandRequestSchema.parse({ command: "open Teams" })).toThrow();
  });
});

describe("computer use over IPC", () => {
  it("takes a step line or a Confirm prompt for one run, within one island line", () => {
    expect(computerUpdateSchema.parse({ runId: 4, type: "step", label: "Clicking Send…" })).toEqual({ runId: 4, type: "step", label: "Clicking Send…" });
    const confirm = { runId: 4, type: "confirm", id: 1, kind: "send", question: "Send this?", detail: "Click “Send” in Discord" };
    expect(computerUpdateSchema.parse(confirm)).toEqual(confirm);
    expect(computerUpdateSchema.safeParse({ ...confirm, kind: "launch" }).success).toBe(false);
    expect(computerUpdateSchema.safeParse({ runId: 4, type: "step", label: "x".repeat(COMPUTER_LINE_MAX + 1) }).success).toBe(false);
    expect(computerUpdateSchema.safeParse({ runId: 4, type: "click" }).success).toBe(false);
  });

  it("takes a Confirm or Cancel tap and a Stop only with a run id", () => {
    expect(computerAnswerSchema.parse({ runId: 4, id: 1, confirmed: true })).toEqual({ runId: 4, id: 1, confirmed: true });
    for (const bad of [{ runId: 4, id: 1 }, { runId: 4, id: 0, confirmed: true }, { id: 1, confirmed: true }, { runId: 4, id: 1, confirmed: "yes" }]) {
      expect(computerAnswerSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(commandStopSchema.parse({ runId: "run-1" })).toEqual({ runId: "run-1" });
    expect(commandStopSchema.safeParse({}).success).toBe(false);
  });

  it("reports access as agent-desktop's states only", () => {
    expect(computerAccessSchema.parse({ supported: true, platform: "mac", accessibility: "denied", screenRecording: "granted" }).accessibility).toBe("denied");
    expect(computerAccessSchema.safeParse({ supported: true, platform: "linux", accessibility: "denied", screenRecording: "granted" }).success).toBe(false);
  });
});

