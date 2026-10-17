import { describe, expect, it } from "vitest";
import { buildLinkRequest, parseLinkDecision } from "./link-jev";
import { buildCandidate } from "./link-rank";

const chip = { id: "vercel.com", domain: "vercel.com", url: "https://vercel.com/", label: "vercel.com" };
const candidate = buildCandidate(chip, [{ url: "https://vercel.com/acme/vibot/logs", title: "logs", source: "bookmark" }]);

describe("buildLinkRequest", () => {
  it("asks one suggest question and one per URL, as 0–3 scores", () => {
    const request = buildLinkRequest("vercel logs", candidate);
    expect(request.state).toEqual({ transcript: "vercel logs" });
    expect(Object.keys(request.questions)).toEqual(["suggest", "u0", "u1"]);
    expect(request.questions.u0).toMatchObject({ type: "score", instructions: { pageUrl: "https://vercel.com/acme/vibot/logs", pageTitle: "logs" } });
    expect(request.questions.suggest).toMatchObject({ type: "score", criteria: expect.arrayContaining([expect.any(String)]) });
  });
});

describe("parseLinkDecision", () => {
  it("reads scores by key and nulls anything missing or not a score", () => {
    const decision = parseLinkDecision(candidate, { suggest: { type: "score", score: 2.5 }, u0: { type: "boolean" }, u1: { type: "score", score: Number.NaN } });
    expect(decision).toEqual({ suggest: 2.5, urls: [null, null] });
  });
});
