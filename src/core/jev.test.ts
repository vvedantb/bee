import type { Experimental_EvaluationModel } from "ai";
import { describe, expect, it } from "vitest";
import { JEV_RELEVANCE_LEVELS, buildJevRequest, parseJevRanking, rankWithJev } from "./jev";
import type { Snippet } from "./notes";

const candidates: Snippet[] = [
  { id: "a", title: "A", text: "alpha" },
  { id: "b", title: "B", text: "beta" },
  { id: "c", title: "C", text: "gamma" },
];

function ids(ranked: { candidate: Snippet }[]): string[] {
  return ranked.map((item) => item.candidate.id);
}

describe("buildJevRequest", () => {
  it("builds one score question per candidate keyed by position", () => {
    const request = buildJevRequest(["hello", "world"], candidates);
    expect(request.state).toEqual({ transcript: "hello\nworld" });
    expect(Object.keys(request.questions)).toEqual(["c0", "c1", "c2"]);
    expect(request.questions.c1).toEqual({
      type: "score",
      instructions: {
        task: "Rate how relevant this note is to what the meeting is discussing right now.",
        noteTitle: "B",
        noteText: "beta",
      },
      criteria: JEV_RELEVANCE_LEVELS,
    });
  });
});

describe("parseJevRanking", () => {
  it("orders by score, highest first", () => {
    const { ranked, scoredCount } = parseJevRanking(candidates, {
      c0: { type: "score", score: 0.4 },
      c1: { type: "score", score: 2.9 },
      c2: { type: "score", score: 1.5 },
    });
    expect(ids(ranked)).toEqual(["b", "c", "a"]);
    expect(ranked[0]?.jevScore).toBe(2.9);
    expect(scoredCount).toBe(3);
  });

  it("keeps retrieval order on ties", () => {
    const { ranked } = parseJevRanking(candidates, {
      c0: { type: "score", score: 1 },
      c1: { type: "score", score: 1 },
      c2: { type: "score", score: 2 },
    });
    expect(ids(ranked)).toEqual(["c", "a", "b"]);
  });

  it("puts missing, wrong-type and out-of-range answers last in original order", () => {
    const { ranked, scoredCount } = parseJevRanking(candidates, {
      c0: { type: "boolean" },
      c1: { type: "score", score: 7 },
      c2: { type: "score", score: 0.2 },
    });
    expect(ids(ranked)).toEqual(["c", "a", "b"]);
    expect(ranked.map((item) => item.jevScore)).toEqual([0.2, null, null]);
    expect(scoredCount).toBe(1);
  });

  it("returns original order when there are no answers", () => {
    const { ranked, scoredCount } = parseJevRanking(candidates, {});
    expect(ids(ranked)).toEqual(["a", "b", "c"]);
    expect(scoredCount).toBe(0);
  });
});

function fakeModel(doEvaluate: () => Promise<{ answers: Record<string, { type: "score"; score: number }>; warnings: [] }>): Experimental_EvaluationModel {
  return {
    specificationVersion: "v4",
    provider: "fake",
    modelId: "fake-jev",
    supportedQuestionTypes: ["score"],
    doEvaluate,
  };
}

describe("rankWithJev", () => {
  it("fails open with the original order and a clear error", async () => {
    const outcome = await rankWithJev({
      model: fakeModel(() => Promise.reject(new Error("boom"))),
      transcript: ["hi"],
      candidates,
    });
    expect(outcome.source).toBe("fallback");
    expect(outcome.error).toContain("Jev ranking failed");
    expect(outcome.error).toContain("boom");
    expect(ids(outcome.ranked)).toEqual(["a", "b", "c"]);
  });

  it("uses Jev scores when the call succeeds", async () => {
    const outcome = await rankWithJev({
      model: fakeModel(() =>
        Promise.resolve({
          answers: { c0: { type: "score", score: 0 }, c1: { type: "score", score: 1 }, c2: { type: "score", score: 3 } },
          warnings: [],
        }),
      ),
      transcript: ["hi"],
      candidates,
    });
    expect(outcome.source).toBe("jev");
    expect(outcome.error).toBeNull();
    expect(ids(outcome.ranked)).toEqual(["c", "b", "a"]);
  });
});
