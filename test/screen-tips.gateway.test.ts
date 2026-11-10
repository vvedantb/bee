import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GUIDE_MODEL, createBeeGateway } from "../src/core/gateway";
import { guideWithLuna } from "../src/core/luna";

// Live: a meeting tip that needs the screen. The front window is a shared slide (video in a call, so no readable text); its
// picture (test/fixtures/slide-kestrel.jpg, made with ffmpeg drawtext) is the only place the budget appears. Skipped without
// BEE_AI_GATEWAY_API_KEY: npm run test:gateway.

const apiKey = process.env.BEE_AI_GATEWAY_API_KEY?.trim();
const SLIDE = readFileSync(join(import.meta.dirname, "fixtures", "slide-kestrel.jpg")).toString("base64");

describe.skipIf(!apiKey)("Luna with the screen", () => {
  it(`${GUIDE_MODEL} answers from a picture of the shared slide`, async () => {
    const gateway = createBeeGateway(apiKey ?? "");
    const result = await guideWithLuna({
      model: gateway(GUIDE_MODEL),
      transcript: ["Priya: Can someone remind me what launch budget is on this slide?"],
      notes: [],
      webSearch: false,
      screenGlance: { app: "Microsoft Teams", title: "Kestrel launch | Meeting | Microsoft Teams", text: "", picture: { data: SLIDE, mediaType: "image/jpeg" } },
    });
    console.log("Luna screen tips:", result.tips);
    expect(result.error).toBeNull();
    expect(result.tips.join(" ")).toMatch(/7[,.]?340/);
  });
});
