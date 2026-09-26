import { experimental_evaluate, type Experimental_EvaluationModel, type Experimental_EvaluationQuestion } from "ai";
import { FLEX_PROVIDER_OPTIONS } from "./gateway";
import type { Snippet } from "./notes";

/**
 * Jev prompt format
 *
 * Jev is an evaluation model, so it is called through the Gateway evaluation API
 * (AI SDK `experimental_evaluate`), not chat completions.
 *
 * - state: `{ transcript }` — the recent meeting lines, oldest first.
 * - questions: one `score` question per candidate, keyed `c0`, `c1`, … in
 *   retrieval order. Each question carries the note title and text and asks how
 *   relevant it is to the conversation right now.
 * - criteria: four ordered levels (0 = irrelevant … 3 = directly useful).
 *
 * Jev returns a fractional score in [0, 3] per question. Candidates are sorted
 * by score, highest first. Any failure returns the original retrieval order.
 */
export const JEV_RELEVANCE_LEVELS = [
  "Irrelevant: unrelated to what is being discussed.",
  "Loosely related: same broad area, but not useful right now.",
  "Relevant: useful background for the current topic.",
  "Directly useful: answers or informs what is being discussed right now.",
];

// Notes scoring below this (on the 0–3 scale) are dropped before guidance.
export const JEV_MIN_SCORE = 1;

const JEV_TIMEOUT_MS = 15_000;

export type JevRequest = {
  state: { transcript: string };
  questions: Record<string, Experimental_EvaluationQuestion>;
};

export type JevAnswer = { type: "score"; score: number } | { type: "choice" | "boolean" };

export type Ranked<T> = { candidate: T; jevScore: number | null };

export type RankOutcome<T> = {
  ranked: Ranked<T>[];
  source: "jev" | "fallback";
  error: string | null;
};

export function questionId(index: number): string {
  return `c${index}`;
}

export function buildJevRequest(transcript: string[], candidates: Snippet[]): JevRequest {
  const questions: Record<string, Experimental_EvaluationQuestion> = {};
  candidates.forEach((candidate, index) => {
    questions[questionId(index)] = {
      type: "score",
      instructions: {
        task: "Rate how relevant this note is to what the meeting is discussing right now.",
        noteTitle: candidate.title,
        noteText: candidate.text,
      },
      criteria: JEV_RELEVANCE_LEVELS,
    };
  });
  return { state: { transcript: transcript.join("\n") }, questions };
}

/**
 * Turn Jev answers into an ordering. Scored candidates come first (highest score first);
 * candidates with a missing or invalid answer keep their retrieval order at the end.
 */
export function parseJevRanking<T>(
  candidates: T[],
  answers: Readonly<Record<string, JevAnswer>>,
): { ranked: Ranked<T>[]; scoredCount: number } {
  const maxScore = JEV_RELEVANCE_LEVELS.length - 1;
  const withScores = candidates.map((candidate, index) => {
    const answer = answers[questionId(index)];
    const score = answer?.type === "score" && Number.isFinite(answer.score) ? answer.score : null;
    const valid = score !== null && score >= 0 && score <= maxScore;
    return { candidate, jevScore: valid ? score : null, index };
  });
  const scoredCount = withScores.filter((item) => item.jevScore !== null).length;
  const ranked = withScores
    .sort((a, b) => {
      if (a.jevScore === null || b.jevScore === null) {
        if (a.jevScore === b.jevScore) return a.index - b.index;
        return a.jevScore === null ? 1 : -1;
      }
      return b.jevScore - a.jevScore || a.index - b.index;
    })
    .map(({ candidate, jevScore }) => ({ candidate, jevScore }));
  return { ranked, scoredCount };
}

function fallback<T>(candidates: T[], error: string): RankOutcome<T> {
  return { ranked: candidates.map((candidate) => ({ candidate, jevScore: null })), source: "fallback", error };
}

/** Rank candidates with Jev. Fails open: on any error, returns the original order and the error message. */
export async function rankWithJev<T extends Snippet>(args: {
  model: Experimental_EvaluationModel;
  transcript: string[];
  candidates: T[];
  timeoutMs?: number;
}): Promise<RankOutcome<T>> {
  if (args.candidates.length === 0) return { ranked: [], source: "jev", error: null };
  try {
    const request = buildJevRequest(args.transcript, args.candidates);
    const result = await experimental_evaluate({
      model: args.model,
      state: request.state,
      questions: request.questions,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(args.timeoutMs ?? JEV_TIMEOUT_MS),
      providerOptions: FLEX_PROVIDER_OPTIONS,
    });
    const { ranked, scoredCount } = parseJevRanking(args.candidates, result.answers);
    if (scoredCount === 0) return fallback(args.candidates, "Jev returned no usable scores");
    return { ranked, source: "jev", error: null };
  } catch (error) {
    return fallback(args.candidates, `Jev ranking failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
