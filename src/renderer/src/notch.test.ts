import { describe, expect, it } from "vitest";
import type { PipelineResult } from "../../shared/ipc";
import { logoState } from "./notch";

const idle: Parameters<typeof logoState>[0] = {
  busy: false,
  tools: [],
  done: false,
  mic: { on: false, level: 0, error: null },
  error: null,
  result: null,
  summary: { saving: false, result: null, error: null },
  mcp: { servers: [], tests: {}, error: null },
  update: { status: "idle", check: null, error: null },
  teamsError: null,
};

const failedRun: PipelineResult = {
  notes: [],
  rankSource: "fallback",
  rankError: null,
  tips: [],
  sources: [],
  guideError: "Luna guidance failed: timeout",
  timingsMs: { retrieve: 0, rank: 0, guide: 0, mcp: 0, lunaFirstToken: null, lunaTotal: 0 },
};

describe("logoState", () => {
  it("rests when nothing is happening and listens while the mic is on", () => {
    expect(logoState(idle)).toBe("idle");
    expect(logoState({ ...idle, mic: { on: true, level: 0.4, error: null } })).toBe("listening");
  });

  it("thinks while busy, over the mic and over a done loop", () => {
    expect(logoState({ ...idle, busy: true, done: true, mic: { on: true, level: 0, error: null } })).toBe("thinking");
  });

  it("searches for web_search, uses a tool for any other call, and prefers web search when both run", () => {
    expect(logoState({ ...idle, busy: true, tools: ["web_search"] })).toBe("searching");
    for (const tool of ["read_file", "append_note", "vmem__search"]) expect(logoState({ ...idle, busy: true, tools: [tool] })).toBe("tool");
    expect(logoState({ ...idle, busy: true, tools: ["vmem__search", "web_search"] })).toBe("searching");
  });

  it("plays done after tips, over listening", () => {
    expect(logoState({ ...idle, done: true, mic: { on: true, level: 0, error: null } })).toBe("done");
  });

  it("shows any error over everything else", () => {
    const busy = { ...idle, busy: true, tools: ["web_search"], done: true, mic: { on: true, level: 1, error: null } };
    expect(logoState({ ...busy, error: "Pipeline failed" })).toBe("error");
    expect(logoState({ ...busy, mic: { on: false, level: 0, error: "Microphone blocked" } })).toBe("error");
    expect(logoState({ ...busy, summary: { saving: false, result: null, error: "Could not save" } })).toBe("error");
    expect(logoState({ ...busy, mcp: { servers: [], tests: {}, error: "Bad URL" } })).toBe("error");
    expect(logoState({ ...busy, update: { status: "idle", check: null, error: "Offline" } })).toBe("error");
    expect(logoState({ ...busy, teamsError: "Sync failed" })).toBe("error");
  });

  it("counts the last run's guide error only once no newer run is busy", () => {
    expect(logoState({ ...idle, result: failedRun })).toBe("error");
    expect(logoState({ ...idle, result: failedRun, busy: true })).toBe("thinking");
  });
});
