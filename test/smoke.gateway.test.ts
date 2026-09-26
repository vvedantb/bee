import { describe, expect, it } from "vitest";
import { JEV_MODEL, LUNA_MODEL, createBeeGateway } from "../src/core/gateway";
import { rankWithJev } from "../src/core/jev";
import { guideWithLuna } from "../src/core/luna";
import type { Snippet } from "../src/core/notes";

const apiKey = process.env.BEE_AI_GATEWAY_API_KEY?.trim();
if (!apiKey) {
  throw new Error("BEE_AI_GATEWAY_API_KEY is not set. Export it, then run npm run test:gateway again.");
}
const gateway = createBeeGateway(apiKey);

const transcript = [
  "Thanks for joining. Main item today is the Acme renewal.",
  "Their procurement lead is pushing for a bigger discount than last year.",
];

// Deliberately out of relevance order, so a working ranker must reorder them.
const notes: Snippet[] = [
  { id: "lunch", title: "Office lunch", text: "Friday lunch is pizza. Vegan options on request." },
  { id: "hiring", title: "Backend hiring › Salary band", text: "Band is £85,000 to £100,000." },
  {
    id: "acme",
    title: "Acme renewal › Pricing",
    text: "10% loyalty discount agreed in Q2 if they renew before 31 October. Do not exceed 15% without finance sign-off.",
  },
];

describe("Vercel AI Gateway smoke", () => {
  it(`${LUNA_MODEL} returns short guidance`, async () => {
    const result = await guideWithLuna({ model: gateway(LUNA_MODEL), transcript, notes: notes.filter((note) => note.id === "acme") });
    console.log("Luna tips:", result.tips);
    expect(result.error).toBeNull();
    expect(result.tips.length).toBeGreaterThan(0);
  });

  it(`${JEV_MODEL} ranks the relevant note first`, async () => {
    const outcome = await rankWithJev({ model: gateway.evaluationModel(JEV_MODEL), transcript, candidates: notes });
    console.log(
      "Jev ranking:",
      outcome.ranked.map((item) => `${item.candidate.id}=${item.jevScore?.toFixed(2) ?? "n/a"}`),
    );
    expect(outcome.error, `Jev failed (the app would fall back to retrieval order): ${outcome.error}`).toBeNull();
    expect(outcome.source).toBe("jev");
    expect(outcome.ranked[0]?.candidate.id).toBe("acme");
    expect(outcome.ranked.every((item) => item.jevScore !== null)).toBe(true);
  });

  it("Jev fails open with a clear error when the key is rejected", async () => {
    const outcome = await rankWithJev({
      model: createBeeGateway("invalid-key").evaluationModel(JEV_MODEL),
      transcript,
      candidates: notes,
    });
    console.log("Fail-open error:", outcome.error);
    expect(outcome.source).toBe("fallback");
    expect(outcome.error).toMatch(/^Jev ranking failed: /);
    expect(outcome.ranked.map((item) => item.candidate.id)).toEqual(["lunch", "hiring", "acme"]);
  });
});
