import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pipelineRequestSchema, pipelineResultSchema } from "../shared/ipc";
import type { BeeGateway } from "./gateway";
import { rankWithJev } from "./jev";
import { guideWithLuna, type LunaResult } from "./luna";
import type { McpTools } from "./mcp";
import { SEED_NOTES, chunkNotes } from "./notes";
import { runPipeline } from "./pipeline";

vi.mock("./jev", () => ({ rankWithJev: vi.fn() }));
vi.mock("./luna", async (importOriginal) => ({ ...(await importOriginal<typeof import("./luna")>()), guideWithLuna: vi.fn() }));

const rank = vi.mocked(rankWithJev);
const guide = vi.mocked(guideWithLuna);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const snippets = chunkNotes(SEED_NOTES);
const transcript = ["When does SSO ship for enterprise customers?"];
const gateway = { languageModel: () => ({}), evaluationModel: () => ({}) } as unknown as BeeGateway;

const lunaOk = (extra: Partial<LunaResult> = {}): LunaResult => ({ tips: ["SSO ships in Q4 [n1]"], sources: [], error: null, skipped: null, firstTokenMs: 12, totalMs: 30, ...extra });

// Jev scores every candidate it is given, in reverse order, so its order differs from BM25's.
function jevAfter(ms: number, started?: (at: number) => void, finished?: (at: number) => void) {
  rank.mockImplementation((async (args: { candidates: Array<{ id: string }> }) => {
    started?.(performance.now());
    await sleep(ms);
    finished?.(performance.now());
    return { ranked: [...args.candidates].reverse().map((candidate, index) => ({ candidate, jevScore: 2.5 - index * 0.1 })), source: "jev" as const, error: null };
  }) as never);
}

function mcpTools(close: () => Promise<void> = async () => undefined, extra: Partial<McpTools> = {}): McpTools {
  return { tools: {}, errors: [], servers: [], close, ...extra };
}

beforeEach(() => {
  rank.mockReset();
  guide.mockReset();
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("runPipeline", () => {
  it("still retrieves notes locally when no Gateway key is set", async () => {
    const result = await runPipeline({ transcript: ["When does SSO ship?"], snippets, gateway: null });
    expect(result.notes[0]?.title).toBe("Q4 product roadmap › Dates");
    expect(result.notes.every((note) => note.jevScore === null && note.cite === null)).toBe(true);
    expect(result.rankSource).toBe("fallback");
    expect(result.guideError).toContain("No AI Gateway key");
    expect(result.tips).toEqual([]);
    expect(result.sources).toEqual([]);
    expect(pipelineResultSchema.parse(result).timingsMs).toMatchObject({ mcp: 0, lunaFirstToken: null, lunaTotal: 0 });
    expect(rank).not.toHaveBeenCalled();
  });

  it("returns timings that match the schema, in ms", async () => {
    jevAfter(5);
    guide.mockResolvedValue(lunaOk());
    const result = await runPipeline({ transcript, snippets, gateway, loadMcpTools: async () => mcpTools() });
    const { timingsMs } = pipelineResultSchema.parse(result);
    expect(Object.keys(timingsMs).sort()).toEqual(["guide", "lunaFirstToken", "lunaTotal", "mcp", "rank", "retrieve"]);
    expect(timingsMs.rank).toBeGreaterThanOrEqual(4);
    expect(timingsMs.lunaFirstToken).toBe(12);
    expect(timingsMs.lunaTotal).toBe(30);
  });

  it("accepts at most 3 shown tips in a pipeline request", () => {
    const base = { transcript: ["a"], sessionToken: "t" };
    expect(pipelineRequestSchema.parse({ ...base, shown: ["x", "y", "z"] }).shown).toHaveLength(3);
    expect(pipelineRequestSchema.parse(base).shown).toBeUndefined();
    expect(() => pipelineRequestSchema.parse({ ...base, shown: ["a", "b", "c", "d"] })).toThrow();
  });

  it("passes the shown tips to Luna as a keep list", async () => {
    jevAfter(1);
    guide.mockResolvedValue(lunaOk());
    await runPipeline({ transcript, shown: ["Tip already on screen"], snippets, gateway });
    expect(guide.mock.calls[0]?.[0].shown).toEqual(["Tip already on screen"]);
  });

  it("passes the earlier answer to Luna on a new turn, and accepts at most 3", async () => {
    jevAfter(1);
    guide.mockResolvedValue(lunaOk());
    await runPipeline({ transcript, earlier: ["District line closed Saturday"], turnLines: 1, snippets, gateway });
    expect(guide.mock.calls[0]?.[0].earlier).toEqual(["District line closed Saturday"]);
    expect(guide.mock.calls[0]?.[0].turnLines).toBe(1);
    expect(() => pipelineRequestSchema.parse({ transcript: ["a"], sessionToken: "t", earlier: ["a", "b", "c", "d"] })).toThrow();
  });

  it("passes the meeting brief to Luna, and nothing when there is none", async () => {
    jevAfter(1);
    guide.mockResolvedValue(lunaOk());
    await runPipeline({ transcript, meetingBrief: "Meeting: Weekly Sync", snippets, gateway });
    expect(guide.mock.calls[0]?.[0].meetingBrief).toBe("Meeting: Weekly Sync");
    await runPipeline({ transcript, snippets, gateway });
    expect(guide.mock.calls[1]?.[0].meetingBrief).toBeUndefined();
  });

  it("starts MCP and Luna's prompt while Jev is still running", async () => {
    let jevEnd = 0;
    let mcpStart = 0;
    let lunaStart = 0;
    jevAfter(120, undefined, (at) => (jevEnd = at));
    guide.mockImplementation(async () => {
      lunaStart = performance.now();
      return lunaOk();
    });
    await runPipeline({
      transcript,
      snippets,
      gateway,
      loadMcpTools: async () => {
        mcpStart = performance.now();
        await sleep(30);
        return mcpTools();
      },
    });
    expect(mcpStart).toBeGreaterThan(0);
    expect(mcpStart).toBeLessThan(jevEnd - 60);
    expect(lunaStart).toBeLessThan(jevEnd - 30);
  });

  it("keeps MCP wait out of the guide time", async () => {
    jevAfter(5);
    guide.mockImplementation(async () => {
      await sleep(40);
      return lunaOk();
    });
    const result = await runPipeline({
      transcript,
      snippets,
      gateway,
      loadMcpTools: async () => {
        await sleep(200);
        return mcpTools();
      },
    });
    expect(result.timingsMs.mcp).toBeGreaterThanOrEqual(190);
    expect(result.timingsMs.guide).toBeGreaterThanOrEqual(35);
    expect(result.timingsMs.guide).toBeLessThan(150);
  });

  it("does not gate Luna's notes on Jev: Luna gets the BM25 top notes at once, the panel gets Jev's order", async () => {
    jevAfter(20);
    guide.mockResolvedValue(lunaOk());
    const result = await runPipeline({ transcript, snippets, gateway });
    const sent = guide.mock.calls[0]?.[0].notes ?? [];
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThanOrEqual(3);
    // Luna's notes are in retrieval order, and the panel's cites name exactly those.
    expect(result.notes.filter((note) => note.cite !== null).map((note) => note.id).sort()).toEqual(sent.map((note) => note.id).sort());
    sent.forEach((note, index) => expect(result.notes.find((item) => item.id === note.id)?.cite).toBe(`n${index + 1}`));
    // Jev reversed the candidates; the panel list follows Jev.
    expect(result.notes.map((note) => note.id)).not.toEqual(sent.map((note) => note.id));
    expect(result.notes.every((note) => note.jevScore !== null)).toBe(true);
    expect(result.rankSource).toBe("jev");
  });

  it("streams tips while Jev is still running, then waits for Jev before returning", async () => {
    const events: string[] = [];
    jevAfter(100, undefined, () => events.push("jev-done"));
    guide.mockImplementation(async (args) => {
      args.onPartial?.(["First tip appears now"]);
      await sleep(10);
      return lunaOk();
    });
    const result = await runPipeline({ transcript, snippets, gateway, onPartial: (tips) => events.push(`partial:${tips.length}`) });
    expect(events).toEqual(["partial:1", "jev-done"]);
    expect(result.rankSource).toBe("jev");
  });

  it("returns without waiting for MCP to close", async () => {
    jevAfter(5);
    guide.mockResolvedValue(lunaOk());
    let closed = 0;
    const started = Date.now();
    await runPipeline({
      transcript,
      snippets,
      gateway,
      loadMcpTools: async () =>
        mcpTools(() => {
          closed++;
          return new Promise<void>(() => undefined);
        }),
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(closed).toBe(1);
  });

  it("survives a close that throws, and a loader that throws", async () => {
    jevAfter(5);
    guide.mockResolvedValue(lunaOk());
    const closing = await runPipeline({ transcript, snippets, gateway, loadMcpTools: async () => mcpTools(() => Promise.reject(new Error("stuck"))) });
    expect(closing.tips).toHaveLength(1);
    const loading = await runPipeline({
      transcript,
      snippets,
      gateway,
      loadMcpTools: async () => {
        throw new Error("boom");
      },
    });
    expect(loading.tips).toHaveLength(1);
    expect(guide.mock.calls.at(-1)?.[0].extraTools).toBeUndefined();
  });

  it("stops hanging Jev and Luna calls when the run is cancelled", async () => {
    const hang = (signal: AbortSignal | undefined) => new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    rank.mockImplementation((async (args: { candidates: Array<{ id: string }>; signal?: AbortSignal }) => {
      try {
        await hang(args.signal);
      } catch {
        // Jev fails open.
      }
      return { ranked: args.candidates.map((candidate) => ({ candidate, jevScore: null })), source: "fallback" as const, error: "Jev ranking failed: aborted" };
    }) as never);
    guide.mockImplementation(async (args) => {
      try {
        await hang(args.signal);
      } catch (error) {
        return lunaOk({ tips: [], error: `AI guidance failed: ${(error as Error).message}` });
      }
      return lunaOk();
    });
    const controller = new AbortController();
    const started = Date.now();
    const pending = runPipeline({ transcript, snippets, gateway, signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.guideError).toContain("aborted");
    expect(rank.mock.calls[0]?.[0].signal).toBe(controller.signal);
    expect(guide.mock.calls[0]?.[0].signal).toBe(controller.signal);
  });

  it("passes the servers to Luna and carries MCP errors through to the result", async () => {
    jevAfter(5);
    guide.mockResolvedValue(lunaOk());
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const servers = [{ name: "vmem", prefix: "vmem", toolCount: 77 }];
    const errors = [
      { server: "Eva", error: "Sign in from the Connectors tab" },
      { server: "Long", error: "x".repeat(500) },
    ];
    const result = await runPipeline({ transcript, snippets, gateway, loadMcpTools: async () => mcpTools(undefined, { servers, errors }) });
    expect(guide.mock.calls[0]?.[0]).toMatchObject({
      connectedServers: servers,
      unavailableServers: [{ name: "Eva", error: "Sign in from the Connectors tab" }, { name: "Long", error: "x".repeat(500) }],
    });
    const parsed = pipelineResultSchema.parse(result);
    expect(parsed.mcpErrors?.[0]).toEqual({ server: "Eva", error: "Sign in from the Connectors tab" });
    expect(parsed.mcpErrors?.[1]?.error).toHaveLength(300);
    // No loader, or no errors: an empty list.
    expect((await runPipeline({ transcript, snippets, gateway })).mcpErrors).toEqual([]);
  });

  it("logs numbers only, never transcript or note text", async () => {
    const debug = vi.mocked(console.debug);
    jevAfter(5);
    guide.mockResolvedValue(lunaOk());
    await runPipeline({ transcript: ["Quarterly roadmap sso zebra"], snippets, gateway, loadMcpTools: async () => mcpTools() });
    await sleep(5);
    const logged = debug.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(logged).toMatch(/perf retrieve \d+ms/);
    expect(logged).toMatch(/perf jev \d+ms mcp \d+ms guide \d+ms/);
    expect(logged).not.toMatch(/zebra|roadmap|SSO ships/i);
  });
});
