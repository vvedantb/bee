import type { PipelineResult } from "../shared/ipc";
import { JEV_MODEL, GUIDE_MODEL, NO_GATEWAY_KEY, type BeeGateway } from "./gateway";
import { rankWithJev } from "./jev";
import type { McpTools } from "./mcp";
import { guideWithLuna, noteCitation } from "./luna";
import type { Snippet } from "./notes";
import { retrieve, transcriptQuery } from "./retrieve";

const RETRIEVE_LIMIT = 5;
const GUIDE_NOTE_LIMIT = 3;
// Bounds for the result's mcpErrors (shared/ipc.ts pipelineResultSchema).
const MCP_ERRORS_MAX = 20;
const MCP_ERROR_CHARS = 300;

// Fail open: if the loader itself throws, Luna runs without MCP tools.
async function loadMcp(load: (() => Promise<McpTools>) | undefined): Promise<McpTools | null> {
  if (!load) return null;
  try {
    const mcp = await load();
    for (const { server, error } of mcp.errors) console.warn(`Bee: MCP server "${server}" skipped: ${error}`);
    return mcp;
  } catch {
    return null;
  }
}

/** Runs the work and returns it with its own wall time in ms. */
async function timed<T>(work: Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await work;
  return { value, ms: performance.now() - started };
}

/**
 * transcript → retrieve, then Jev, MCP load and Luna together. Without a gateway, only local retrieval runs.
 * Luna gets the BM25 top notes at once; Jev only orders and scores the panel's notes, so it never delays a tip.
 */
export async function runPipeline(args: {
  transcript: string[];
  /** Tips already on screen, passed to Luna as a keep list (live steering). */
  shown?: string[];
  /** The brief for the meeting in progress (title, people, agenda, earlier decisions). Sent to Luna with every turn. */
  meetingBrief?: string;
  snippets: Snippet[];
  gateway: BeeGateway | null;
  notesDir?: string;
  extraRoots?: readonly string[];
  /** Connects the user's MCP servers. It starts at once, beside Jev. The run lets go of them in the background when it ends. */
  loadMcpTools?: () => Promise<McpTools>;
  onActivity?: (toolName: string) => void;
  /** Tips so far, as Luna streams them. Does not wait for Jev. */
  onPartial?: (tips: string[]) => void;
  /** Cancels Jev and Luna for a superseded run. */
  signal?: AbortSignal;
}): Promise<PipelineResult> {
  const t0 = performance.now();
  const retrieved = retrieve(transcriptQuery(args.transcript), args.snippets, RETRIEVE_LIMIT);
  const candidates = retrieved.map(({ snippet, score }) => ({ ...snippet, retrieveScore: score }));
  const t1 = performance.now();
  const retrieveMs = t1 - t0;
  console.debug(`perf retrieve ${Math.round(retrieveMs)}ms`);

  if (!args.gateway) {
    return {
      notes: candidates.map((note) => ({ ...note, jevScore: null, cite: null })),
      rankSource: "fallback",
      rankError: NO_GATEWAY_KEY,
      tips: [],
      sources: [],
      guideError: NO_GATEWAY_KEY,
      timingsMs: { retrieve: retrieveMs, rank: 0, guide: 0, mcp: 0, lunaFirstToken: null, lunaTotal: 0 },
    };
  }

  // Luna reads the top BM25 notes, in retrieval order. Jev does not gate them.
  const guideNotes = candidates.slice(0, GUIDE_NOTE_LIMIT);
  const mcpRun = timed(loadMcp(args.loadMcpTools));
  const jevRun = timed(
    rankWithJev({ model: args.gateway.evaluationModel(JEV_MODEL), transcript: args.transcript, candidates, signal: args.signal }),
  );
  const lunaRun = (async () => {
    const { value: mcp, ms: mcpMs } = await mcpRun;
    const started = performance.now();
    const guide = await guideWithLuna({
      model: args.gateway!(GUIDE_MODEL),
      transcript: args.transcript,
      shown: args.shown,
      meetingBrief: args.meetingBrief,
      notes: guideNotes,
      notesDir: args.notesDir,
      extraRoots: args.extraRoots,
      extraTools: mcp?.tools,
      connectedServers: mcp?.servers,
      unavailableServers: mcp?.errors.map(({ server, error }) => ({ name: server, error })),
      onActivity: args.onActivity,
      onPartial: args.onPartial,
      signal: args.signal,
    });
    const guideMs = performance.now() - started;
    // Not awaited: the result must not wait for servers to wind down. close() is bounded and fail-open.
    const closeStarted = performance.now();
    void mcp?.close().catch(() => undefined).finally(() => console.debug(`perf mcp-close ${Math.round(performance.now() - closeStarted)}ms`));
    return { guide, guideMs, mcpMs, mcp };
  })();

  const [{ value: rank, ms: rankMs }, { guide, guideMs, mcpMs, mcp }] = await Promise.all([jevRun, lunaRun]);
  console.debug(`perf jev ${Math.round(rankMs)}ms mcp ${Math.round(mcpMs)}ms guide ${Math.round(guideMs)}ms`);

  const guideIds = new Set(guideNotes.map((note) => note.id));
  const notes = rank.ranked.map(({ candidate, jevScore }) => {
    const index = guideNotes.findIndex((note) => note.id === candidate.id);
    return { ...candidate, jevScore, cite: guideIds.has(candidate.id) ? noteCitation(index) : null };
  });

  return {
    notes,
    rankSource: rank.source,
    rankError: rank.error,
    tips: guide.tips,
    sources: guide.sources,
    guideError: guide.error,
    guideNote: guide.skipped,
    mcpErrors: (mcp?.errors ?? []).slice(0, MCP_ERRORS_MAX).map(({ server, error }) => ({ server: server.slice(0, 200), error: error.slice(0, MCP_ERROR_CHARS) })),
    timingsMs: {
      retrieve: retrieveMs,
      rank: rankMs,
      guide: guideMs,
      mcp: mcpMs,
      lunaFirstToken: guide.firstTokenMs,
      lunaTotal: guide.totalMs,
    },
  };
}
