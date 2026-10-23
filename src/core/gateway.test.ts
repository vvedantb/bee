import { describe, expect, it } from "vitest";
import { FLEX_PROVIDER_OPTIONS, GUIDE_MODEL, GUIDE_PROVIDER, gatewayTier, guideProviderOptions } from "./gateway";

describe("gatewayTier", () => {
  it("sends flex only when asked for it", () => {
    expect(gatewayTier("flex")).toEqual({ gateway: { serviceTier: "flex" } });
    expect(FLEX_PROVIDER_OPTIONS).toEqual({ gateway: { serviceTier: "flex" } });
  });

  it("leaves the tier out for the Gateway default", () => {
    expect(gatewayTier("default")).toEqual({});
  });

  it("can name ultrafast, which no call site uses yet", () => {
    expect(gatewayTier("ultrafast")).toEqual({ gateway: { serviceTier: "ultrafast" } });
  });
});

describe("guideProviderOptions", () => {
  it("pins Anthropic with only when web search is sent, and keeps the tier", () => {
    expect(GUIDE_MODEL).toBe("anthropic/claude-haiku-5.5");
    expect(GUIDE_PROVIDER).toBe("anthropic");
    expect(guideProviderOptions("default", { web: true })).toEqual({ gateway: { only: ["anthropic"] } });
    expect(guideProviderOptions("flex", { web: true })).toEqual({ gateway: { serviceTier: "flex", only: ["anthropic"] } });
  });

  it("prefers Anthropic with order, keeping fail-over, when no web search is sent", () => {
    expect(guideProviderOptions("default", { web: false })).toEqual({ gateway: { order: ["anthropic"] } });
    expect(guideProviderOptions("flex", { web: false })).toEqual({ gateway: { serviceTier: "flex", order: ["anthropic"] } });
  });
});
