import { describe, expect, it } from "vitest";
import { FLEX_PROVIDER_OPTIONS, LUNA_PROVIDERS, gatewayTier, lunaProviderOptions } from "./gateway";

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

describe("lunaProviderOptions", () => {
  it("limits Luna to providers that accept web_search and keeps the tier", () => {
    expect(LUNA_PROVIDERS).toEqual(["openai", "azure"]);
    expect(lunaProviderOptions("default")).toEqual({ gateway: { only: ["openai", "azure"] } });
    expect(lunaProviderOptions("flex")).toEqual({ gateway: { serviceTier: "flex", only: ["openai", "azure"] } });
  });
});
