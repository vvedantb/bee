import { afterEach, describe, expect, it, vi } from "vitest";
import { consoleData, debugLog, errorData, onceText, setDebugSink, stepData, teeConsole, type DebugEvent, type DebugLevel } from "./debug-log";

// The process-wide sink: core code calls debugLog anywhere; main or the renderer decides where events go.

function memorySink(levels: DebugLevel[] = ["debug", "info", "warn", "error"]) {
  const events: DebugEvent[] = [];
  return { events, sink: { write: (event: DebugEvent) => events.push(event), wants: (level: DebugLevel) => levels.includes(level) } };
}

afterEach(() => setDebugSink(null));

describe("debugLog", () => {
  it("does nothing without a sink (tests, scripts)", () => {
    expect(() => debugLog.info("app", "start", { a: 1 })).not.toThrow();
    expect(debugLog.wants("error")).toBe(false);
  });

  it("sends events to the sink, at the levels it wants", () => {
    const { events, sink } = memorySink(["warn", "error"]);
    setDebugSink(sink);
    debugLog.debug("ui", "scroll");
    debugLog.info("ai", "run-start", { run: 1 });
    debugLog.warn("stt", "failed", { ms: 3 });
    debugLog.error("app", "crash");
    expect(events).toEqual([
      { level: "warn", category: "stt", event: "failed", data: { ms: 3 } },
      { level: "error", category: "app", event: "crash" },
    ]);
    expect(debugLog.wants("info")).toBe(false);
  });

  it("never lets a broken sink break the caller", () => {
    setDebugSink({
      write: () => {
        throw new Error("disk full");
      },
      wants: () => true,
    });
    expect(() => debugLog.error("app", "crash")).not.toThrow();
    setDebugSink({
      write: () => undefined,
      wants: () => {
        throw new Error("bad");
      },
    });
    expect(() => debugLog.info("app", "start")).not.toThrow();
    expect(debugLog.wants("info")).toBe(false);
  });
});

describe("helpers", () => {
  it("errorData keeps name, message, stack and cause", () => {
    const error = new Error("outer", { cause: new Error("inner") });
    expect(errorData(error)).toMatchObject({ name: "Error", message: "outer", cause: "inner", stack: expect.stringContaining("outer") });
    expect(errorData("plain")).toEqual({ message: "plain" });
    expect(errorData({ code: 7 })).toEqual({ message: '{"code":7}' });
  });

  it("onceText writes a long fixed text once, then its hash only", () => {
    const system = `You are Bee. ${Math.random()}`;
    const first = onceText(system);
    const second = onceText(system);
    expect(first).toEqual({ hash: expect.stringMatching(/^[0-9a-f]{8}$/), chars: system.length, text: system });
    expect(second).toEqual({ hash: first.hash, chars: system.length });
  });

  it("stepData keeps a step's text, tool calls with their input, results and usage", () => {
    const step = {
      stepNumber: 2,
      finishReason: "tool-calls",
      text: "",
      usage: { inputTokens: 10, outputTokens: 5 },
      toolCalls: [{ toolName: "click", toolCallId: "t1", input: { ref: "@s1:e2", effect: "send" } }],
      toolResults: [{ toolName: "click", toolCallId: "t1", output: "Done: clicked." }],
    };
    expect(stepData(step)).toEqual({
      step: 2,
      finishReason: "tool-calls",
      text: "",
      toolCalls: [{ id: "t1", tool: "click", input: { ref: "@s1:e2", effect: "send" } }],
      toolResults: [{ id: "t1", tool: "click", output: "Done: clicked." }],
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  });

  it("consoleData joins the arguments into one line and keeps errors whole", () => {
    const error = new TypeError("nope");
    expect(consoleData(["perf luna", 12, { a: 1 }])).toEqual({ message: 'perf luna 12 {"a":1}' });
    expect(consoleData(["Bee: failed:", error])).toEqual({ message: "Bee: failed: TypeError: nope", errors: [expect.objectContaining({ name: "TypeError", message: "nope" })] });
  });
});

describe("teeConsole", () => {
  it("copies console output into the log and still prints it", () => {
    const { events, sink } = memorySink();
    setDebugSink(sink);
    const printed: unknown[][] = [];
    const target = {
      debug: (...args: unknown[]) => printed.push(["debug", ...args]),
      info: (...args: unknown[]) => printed.push(["info", ...args]),
      log: (...args: unknown[]) => printed.push(["log", ...args]),
      warn: (...args: unknown[]) => printed.push(["warn", ...args]),
      error: (...args: unknown[]) => printed.push(["error", ...args]),
    };
    const restore = teeConsole(target);
    target.debug("perf stt 120ms");
    target.warn("Bee: tray unavailable");
    target.log("hello");
    expect(printed).toEqual([["debug", "perf stt 120ms"], ["warn", "Bee: tray unavailable"], ["log", "hello"]]);
    expect(events).toEqual([
      { level: "debug", category: "console", event: "debug", data: { message: "perf stt 120ms" } },
      { level: "warn", category: "console", event: "warn", data: { message: "Bee: tray unavailable" } },
      { level: "info", category: "console", event: "log", data: { message: "hello" } },
    ]);
    restore();
    target.info("after");
    expect(events).toHaveLength(3);
  });

  it("does not loop when the sink itself prints", () => {
    const target = { debug: vi.fn(), info: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const writes: DebugEvent[] = [];
    setDebugSink({
      write: (event) => {
        writes.push(event);
        target.warn("sink says something");
      },
      wants: () => true,
    });
    teeConsole(target);
    target.error("boom");
    expect(writes).toHaveLength(1);
  });
});
