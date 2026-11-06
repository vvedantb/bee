import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_COMMAND_THINKING,
  ANTHROPIC_CACHE,
  ANTHROPIC_NO_THINKING,
  COMMAND_MODEL,
  FLEX_PROVIDER_OPTIONS,
  GUIDE_MODEL,
  GUIDE_PROVIDER,
  commandProviderOptions,
  gatewayTier,
  guideProviderOptions,
} from "./gateway";

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

describe("commandProviderOptions", () => {
  it("names Sonnet for commands and keeps Haiku for tips", () => {
    expect(COMMAND_MODEL).toBe("anthropic/claude-sonnet-5.5");
    expect(GUIDE_MODEL).toBe("anthropic/claude-haiku-5.5");
  });

  it("routes like guideProviderOptions, with adaptive thinking at medium effort (no budgetTokens)", () => {
    expect(ANTHROPIC_COMMAND_THINKING).toEqual({ anthropic: { thinking: { type: "adaptive" }, effort: "medium" } });
    for (const tier of ["flex", "default", "ultrafast"] as const) {
      for (const web of [true, false]) {
        const options = commandProviderOptions(tier, { web });
        expect(options.gateway).toEqual(guideProviderOptions(tier, { web }).gateway);
        expect(options.anthropic).toEqual({ thinking: { type: "adaptive" }, effort: "medium" });
        expect(JSON.stringify(options)).not.toContain("budgetTokens");
      }
    }
  });

  it("thinks at low effort only when asked (a short computer-use task), never higher than medium", () => {
    expect(commandProviderOptions("default", { web: false, effort: "low" }).anthropic).toEqual({ thinking: { type: "adaptive" }, effort: "low" });
    expect(commandProviderOptions("default", { web: false, effort: "medium" }).anthropic).toEqual({ thinking: { type: "adaptive" }, effort: "medium" });
    expect(commandProviderOptions("default", { web: false }).gateway).toEqual(guideProviderOptions("default", { web: false }).gateway);
  });

  it("leaves the cache marker to the messages, and tips still think nothing", () => {
    expect(commandProviderOptions("default", { web: true }).anthropic).not.toHaveProperty("cacheControl");
    expect(guideProviderOptions("default", { web: true }).anthropic).toEqual({ thinking: { type: "disabled" } });
  });
});

describe("gatewayTier for non-Anthropic models", () => {
  it("sends no anthropic options (Jev, STT)", () => {
    for (const tier of ["flex", "default", "ultrafast"] as const) expect(gatewayTier(tier)).not.toHaveProperty("anthropic");
  });
});
