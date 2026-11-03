import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_BRIEF_THINKING,
  ANTHROPIC_CACHE,
  ANTHROPIC_NO_THINKING,
  COMMAND_MODEL,
  COMMAND_THINKING_BUDGET,
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

  it("routes like guideProviderOptions, with brief thinking on", () => {
    expect(COMMAND_THINKING_BUDGET).toBe(1500);
    expect(ANTHROPIC_BRIEF_THINKING).toEqual({ anthropic: { thinking: { type: "enabled", budgetTokens: 1500 } } });
    for (const tier of ["flex", "default", "ultrafast"] as const) {
      for (const web of [true, false]) {
        const options = commandProviderOptions(tier, { web });
        expect(options.gateway).toEqual(guideProviderOptions(tier, { web }).gateway);
        expect(options.anthropic).toEqual({ thinking: { type: "enabled", budgetTokens: 1500 } });
      }
    }
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
