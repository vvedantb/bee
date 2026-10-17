import type { PipelineResult } from "../shared/ipc";
import { JEV_MODEL, LUNA_MODEL, NO_GATEWAY_KEY, type BeeGateway } from "./gateway";
import { JEV_MIN_SCORE, rankWithJev } from "./jev";
import type { McpTools } from "./mcp";
import { guideWithLuna, noteCitation } from "./luna";
import type { Snippet } from "./notes";
import { retrieve, transcriptQuery } from "./retrieve";

const RETRIEVE_LIMIT = 5;
const GUIDE_NOTE_LIMIT = 3;

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

/** transcript → retrieve → Jev rank → Luna guide. Without a gateway, only local retrieval runs. */
export async function runPipeline(args: {
  transcript: string[];
  snippets: Snippet[];
  gateway: BeeGateway | null;
  notesDir?: string;
  extraRoots?: readonly string[];
  /** Connects the user's MCP servers. Called once Luna is about to run; its connections close when the run ends. */
  loadMcpTools?: () => Promise<McpTools>;
  onActivity?: (toolName: string) => void;
}): Promise<PipelineResult> {
  const t0 = performance.now();
  const retrieved = retrieve(transcriptQuery(args.transcript), args.snippets, RETRIEVE_LIMIT);
  const candidates = retrieved.map(({ snippet, score }) => ({ ...snippet, retrieveScore: score }));
  const t1 = performance.now();

  if (!args.gateway) {
    return {
      notes: candidates.map((note) => ({ ...note, jevScore: null, cite: null })),
      rankSource: "fallback",
      rankError: NO_GATEWAY_KEY,
      tips: [],
      sources: [],
      guideError: NO_GATEWAY_KEY,
      timingsMs: { retrieve: t1 - t0, rank: 0, guide: 0 },
    };
  }

  const rank = await rankWithJev({
    model: args.gateway.evaluationModel(JEV_MODEL),
    transcript: args.transcript,
    candidates,
  });
  const ranked = rank.ranked.map(({ candidate, jevScore }) => ({ ...candidate, jevScore }));
  const t2 = performance.now();

  const guideNotes = ranked
    .filter((note) => note.jevScore === null || note.jevScore >= JEV_MIN_SCORE)
    .slice(0, GUIDE_NOTE_LIMIT);
  const notes = ranked.map((note) => {
    const index = guideNotes.indexOf(note);
    return { ...note, cite: index === -1 ? null : noteCitation(index) };
  });
  const mcp = await loadMcp(args.loadMcpTools);
  const guide = await guideWithLuna({
    model: args.gateway(LUNA_MODEL),
    transcript: args.transcript,
    notes: guideNotes,
    notesDir: args.notesDir,
    extraRoots: args.extraRoots,
    extraTools: mcp?.tools,
    onActivity: args.onActivity,
  }).finally(() => mcp?.close());
  const t3 = performance.now();

  return {
    notes,
    rankSource: rank.source,
    rankError: rank.error,
    tips: guide.tips,
    sources: guide.sources,
    guideError: guide.error,
    guideNote: guide.skipped,
    timingsMs: { retrieve: t1 - t0, rank: t2 - t1, guide: t3 - t2 },
  };
}
