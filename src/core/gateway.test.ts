import { describe, expect, it } from "vitest";
import { ANTHROPIC_CACHE, ANTHROPIC_NO_THINKING, FLEX_PROVIDER_OPTIONS, GUIDE_MODEL, GUIDE_PROVIDER, gatewayTier, guideProviderOptions } from "./gateway";

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
    expect(guideProviderOptions("default", { web: true })).toEqual({ gateway: { only: ["anthropic"] }, ...ANTHROPIC_NO_THINKING });
    expect(guideProviderOptions("flex", { web: true })).toEqual({ gateway: { serviceTier: "flex", only: ["anthropic"] }, ...ANTHROPIC_NO_THINKING });
  });

  it("prefers Anthropic with order, keeping fail-over, when no web search is sent", () => {
    expect(guideProviderOptions("default", { web: false })).toEqual({ gateway: { order: ["anthropic"] }, ...ANTHROPIC_NO_THINKING });
    expect(guideProviderOptions("flex", { web: false })).toEqual({ gateway: { serviceTier: "flex", order: ["anthropic"] }, ...ANTHROPIC_NO_THINKING });
  });

  it("always turns Anthropic thinking off", () => {
    expect(ANTHROPIC_NO_THINKING).toEqual({ anthropic: { thinking: { type: "disabled" } } });
    for (const tier of ["flex", "default", "ultrafast"] as const) {
      for (const web of [true, false]) expect(guideProviderOptions(tier, { web }).anthropic).toEqual({ thinking: { type: "disabled" } });
    }
  });

  it("keeps the call-level thinking option apart from the message-level cache marker", () => {
    expect(ANTHROPIC_CACHE).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
    expect(guideProviderOptions("default", { web: true }).anthropic).not.toHaveProperty("cacheControl");
  });
});

describe("gatewayTier for non-Anthropic models", () => {
  it("sends no anthropic options (Jev, STT)", () => {
    for (const tier of ["flex", "default", "ultrafast"] as const) expect(gatewayTier(tier)).not.toHaveProperty("anthropic");
  });
});
