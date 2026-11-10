import { describe, expect, it } from "vitest";
import { FACT_CHARS, MEMORY_FACTS_MAX, MEMORY_KINDS } from "../core/bee-memory";
import {
  COMMAND_MAX_CHARS,
  COMPUTER_LINE_MAX,
  DEBUG_BATCH_MAX,
  IPC,
  MEMORY_FACT_KINDS,
  TIP_MAX_CHARS,
  clampTip,
  commandRequestSchema,
  commandStopSchema,
  computerAccessSchema,
  computerAnswerSchema,
  computerUpdateSchema,
  debugLogBatchSchema,
  debugLogEventSchema,
  lunaActivitySchema,
  lunaPartialSchema,
  meetingSummaryRequestSchema,
  windowInteractiveSchema,
  windowSizeSchema,
  memoryClearResultSchema,
  memoryFactViewSchema,
  memoryListResultSchema,
  memoryRequestSchema,
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
    expect(computerAccessSchema.safeParse({ supported: true, platform: "linux", accessibility: "denied", screenRecording: "granted" }).success).toBe(true);
    expect(computerAccessSchema.safeParse({ supported: true, platform: "freebsd", accessibility: "denied", screenRecording: "granted" }).success).toBe(false);
  });
});


describe("debug log IPC", () => {
  it("has its own channels, distinct from every other", () => {
    expect(IPC.debugLog).toBe("bee:debug:log");
    expect(IPC.openLogsFolder).toBe("bee:logs:open-folder");
    const channels = Object.values(IPC);
    expect(new Set(channels).size).toBe(channels.length);
  });

  it("takes an event with a time, a level, short names and any data", () => {
    const event = { ts: 1_700_000_000_000, level: "info", category: "teams-audio", event: "run-start.v2", data: { lines: ["a"], nested: { n: 1 } } };
    expect(debugLogEventSchema.parse(event)).toEqual(event);
    expect(debugLogEventSchema.parse({ ts: 1, level: "error", category: "renderer", event: "unhandled-rejection" })).toEqual({ ts: 1, level: "error", category: "renderer", event: "unhandled-rejection" });
  });

  it("rejects unknown levels, odd names, a missing time and data that is not an object", () => {
    const base = { ts: 1, level: "info", category: "ui", event: "scroll" };
    for (const bad of [
      { ...base, level: "trace" },
      { ...base, category: "UI" },
      { ...base, category: "a".repeat(41) },
      { ...base, event: "has space" },
      { ...base, event: "e".repeat(81) },
      { ...base, ts: Number.NaN },
      { level: "info", category: "ui", event: "scroll" },
      { ...base, data: "text" },
    ]) {
      expect(debugLogEventSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("caps a batch at DEBUG_BATCH_MAX events and needs at least one", () => {
    const one = { ts: 1, level: "info", category: "ui", event: "x" };
    expect(debugLogBatchSchema.safeParse({ events: Array(DEBUG_BATCH_MAX).fill(one) }).success).toBe(true);
    expect(debugLogBatchSchema.safeParse({ events: Array(DEBUG_BATCH_MAX + 1).fill(one) }).success).toBe(false);
    expect(debugLogBatchSchema.safeParse({ events: [] }).success).toBe(false);
  });
});

describe("Saved memory schemas", () => {
  const fact = { text: "Sam in Teams is Samuel Jones", kind: "person", updated: "2026-11-05" };

  it("has its own channels, apart from saved meetings", () => {
    expect(IPC.memoryList).toBe("bee:memory:list");
    expect(IPC.memoryClear).toBe("bee:memory:clear");
    expect(IPC.memoryClear).not.toBe(IPC.clearMeetingMemory);
  });

  it("keeps the fact shape in step with Bee's memory", () => {
    expect([...MEMORY_FACT_KINDS]).toEqual([...MEMORY_KINDS]);
    expect(memoryFactViewSchema.safeParse({ ...fact, text: "a".repeat(FACT_CHARS) }).success).toBe(true);
    expect(memoryFactViewSchema.safeParse({ ...fact, text: "a".repeat(FACT_CHARS + 1) }).success).toBe(false);
    expect(memoryListResultSchema.safeParse({ facts: Array.from({ length: MEMORY_FACTS_MAX }, () => fact) }).success).toBe(true);
  });

  it("needs a session token, and rejects an unknown kind or a negative count", () => {
    expect(memoryRequestSchema.safeParse({}).success).toBe(false);
    expect(memoryRequestSchema.parse({ sessionToken: "t" })).toEqual({ sessionToken: "t" });
    expect(memoryListResultSchema.safeParse({ facts: [{ ...fact, kind: "health" }] }).success).toBe(false);
    expect(memoryClearResultSchema.safeParse({ cleared: -1 }).success).toBe(false);
    expect(memoryClearResultSchema.parse({ cleared: 3 })).toEqual({ cleared: 3 });
  });
});

describe("window IPC", () => {
  it("sizes the window by mode alone: the renderer sends no width", () => {
    expect(windowSizeSchema.parse("collapsed")).toBe("collapsed");
    for (const bad of [{ size: "collapsed", width: 296 }, "huge"]) expect(windowSizeSchema.safeParse(bad).success).toBe(false);
  });

  it("takes only a boolean for the click-through switch", () => {
    expect(windowInteractiveSchema.parse(true)).toBe(true);
    for (const bad of ["true", 1, null, undefined]) expect(windowInteractiveSchema.safeParse(bad).success).toBe(false);
  });
});
