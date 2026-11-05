import type { Experimental_EvaluationModel } from "ai";
import { describe, expect, it } from "vitest";
import { ROUTE_OPTIONS, buildRouteRequest, parseRouteAnswer, routeWithJev } from "./command-route-jev";

// Jev's routing with fake evaluation models: no Gateway call.

type Answer = Record<string, unknown>;
/** A complete distribution, as the AI SDK requires: p on one option, the rest shared by the others. */
const dist = (choice: keyof typeof ROUTE_OPTIONS, p: number) => {
  const keys = Object.keys(ROUTE_OPTIONS);
  return Object.fromEntries(keys.map((key) => [key, key === choice ? p : (1 - p) / (keys.length - 1)]));
};
function fakeModel(doEvaluate: (options: { abortSignal?: AbortSignal; questions: Record<string, unknown> }) => Promise<{ answers: Answer; warnings: [] }>) {
  const calls: Array<{ questions: Record<string, unknown>; state: unknown }> = [];
  const model = {
    specificationVersion: "v4",
    provider: "fake",
    modelId: "fake-jev",
    supportedQuestionTypes: ["choice", "score", "boolean"],
    doEvaluate: (options: { abortSignal?: AbortSignal; questions: Record<string, unknown>; state: unknown }) => {
      calls.push({ questions: options.questions, state: options.state });
      return doEvaluate(options);
    },
  } as unknown as Experimental_EvaluationModel;
  return { model, calls };
}

describe("buildRouteRequest", () => {
  it("asks one choice question over the routes, with the request as state", () => {
    const request = buildRouteRequest("  send Sam   a message ");
    expect(request.state).toEqual({ request: "send Sam a message" });
    expect(request.questions.route).toMatchObject({ type: "choice", criteria: ROUTE_OPTIONS });
    expect(Object.keys(ROUTE_OPTIONS)).toEqual(["computer_use", "direct_answer", "open_app", "focus_app", "open_url", "ai"]);
  });
});

describe("parseRouteAnswer", () => {
  it("takes a known choice, unless Jev is unsure of it", () => {
    expect(parseRouteAnswer({ type: "choice", choice: "computer_use" })).toBe("computer_use");
    expect(parseRouteAnswer({ type: "choice", choice: "direct_answer", probabilities: { direct_answer: 0.8, ai: 0.2 } })).toBe("direct_answer");
    expect(parseRouteAnswer({ type: "choice", choice: "computer_use", probabilities: { computer_use: 0.4, ai: 0.35 } })).toBeNull();
  });

  it("drops an unknown option, another answer type or nothing", () => {
    expect(parseRouteAnswer({ type: "choice", choice: "delete_everything" })).toBeNull();
    expect(parseRouteAnswer({ type: "choice", choice: "toString" })).toBeNull();
    expect(parseRouteAnswer({ type: "score", score: 2 })).toBeNull();
    expect(parseRouteAnswer(undefined)).toBeNull();
  });
});

describe("routeWithJev", () => {
  it("returns Jev's route", async () => {
    const { model, calls } = fakeModel(async () => ({ answers: { route: { type: "choice", choice: "computer_use", probabilities: dist("computer_use", 0.9) } }, warnings: [] }));
    expect(await routeWithJev({ model, command: "mute the Teams call" })).toBe("computer_use");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.state).toEqual({ request: "mute the Teams call" });
  });

  it("leaves an unsure answer to the word rules", async () => {
    const { model } = fakeModel(async () => ({ answers: { route: { type: "choice", choice: "computer_use", probabilities: dist("computer_use", 0.3) } }, warnings: [] }));
    expect(await routeWithJev({ model, command: "mute the Teams call" })).toBeNull();
  });

  it("gives up after the time budget, even when the model never answers", async () => {
    const { model } = fakeModel(() => new Promise(() => undefined));
    const started = performance.now();
    expect(await routeWithJev({ model, command: "mute the call", timeoutMs: 50 })).toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("returns null on an error, or a cancelled request", async () => {
    expect(await routeWithJev({ model: fakeModel(() => Promise.reject(new Error("boom"))).model, command: "x" })).toBeNull();
    const cancelled = new AbortController();
    cancelled.abort();
    expect(await routeWithJev({ model: fakeModel(() => new Promise(() => undefined)).model, command: "x", signal: cancelled.signal })).toBeNull();
  });
});
