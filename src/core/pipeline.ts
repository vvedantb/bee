import type { PipelineResult } from "../shared/ipc";
import { JEV_MODEL, LUNA_MODEL, NO_GATEWAY_KEY, type BeeGateway } from "./gateway";
import { JEV_MIN_SCORE, rankWithJev } from "./jev";
import { guideWithLuna, noteCitation } from "./luna";
import type { Snippet } from "./notes";
import { retrieve, transcriptQuery } from "./retrieve";

const RETRIEVE_LIMIT = 5;
const GUIDE_NOTE_LIMIT = 3;

/** transcript → retrieve → Jev rank → Luna guide. Without a gateway, only local retrieval runs. */
export async function runPipeline(args: {
  transcript: string[];
  snippets: Snippet[];
  gateway: BeeGateway | null;
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
  const guide = await guideWithLuna({
    model: args.gateway(LUNA_MODEL),
    transcript: args.transcript,
    notes: guideNotes,
  });
  const t3 = performance.now();

  return {
    notes,
    rankSource: rank.source,
    rankError: rank.error,
    tips: guide.tips,
    guideError: guide.error,
    timingsMs: { retrieve: t1 - t0, rank: t2 - t1, guide: t3 - t2 },
  };
}
