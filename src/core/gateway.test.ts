import { describe, expect, it } from "vitest";
import { FLEX_PROVIDER_OPTIONS, GUIDE_MODEL, GUIDE_PROVIDER_ORDER, gatewayTier, guideProviderOptions } from "./gateway";

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
  it("prefers Anthropic without excluding fail-over providers, and keeps the tier", () => {
    expect(GUIDE_MODEL).toBe("anthropic/claude-haiku-5.5");
    expect(GUIDE_PROVIDER_ORDER).toEqual(["anthropic"]);
    expect(guideProviderOptions("default")).toEqual({ gateway: { order: ["anthropic"] } });
    expect(guideProviderOptions("flex")).toEqual({ gateway: { serviceTier: "flex", order: ["anthropic"] } });
  });
});
