import { createGateway, type GatewayProvider } from "@ai-sdk/gateway";

// The model behind Luna (tips) and meeting summaries.
export const GUIDE_MODEL = "anthropic/claude-haiku-5.5";
export const JEV_MODEL = "typesafe-ai/jev";
// Gateway also lists this model as spacexai/grok-stt; both ids resolve.
export const STT_MODEL = "xai/grok-stt";

// Service tier is a per-call choice. No sampling parameters are ever sent to the Gateway.
//  - "flex": cheaper, may queue and be slower. For background work only (summary, link ranking, Jev ranking).
//  - "default": the Gateway's standard tier (no serviceTier sent). User-facing STT and Luna use it: they sit on the
//    path between the end of speech and the first tip, so a flex queue shows up as felt latency.
//  - "ultrafast": NOT used. It may be rejected by these models (xai/grok-stt, anthropic/claude-haiku-5.5), and no call in this repo
//    has confirmed support. Try it only behind a real-key A/B (test/smoke.gateway.test.ts), then read
//    providerMetadata.gateway.serviceTier to see what the Gateway applied.
export type GatewayTier = "flex" | "default" | "ultrafast";

export function gatewayTier(tier: GatewayTier): { gateway?: { serviceTier: string } } {
  return tier === "default" ? {} : { gateway: { serviceTier: tier } };
}

export const FLEX_PROVIDER_OPTIONS = gatewayTier("flex");

// Gateway provider order for GUIDE_MODEL calls. Anthropic first (the owner's BYOK key); `order`, not `only`,
// so the Gateway can still fail over to bedrock or vertex.
export const GUIDE_PROVIDER_ORDER: readonly string[] = ["anthropic"];

/** The tier's options plus the GUIDE_MODEL provider order. Flex may not apply on Anthropic; the Gateway decides. */
export function guideProviderOptions(tier: GatewayTier): { gateway: { serviceTier?: string; order: string[] } } {
  return { gateway: { ...gatewayTier(tier).gateway, order: [...GUIDE_PROVIDER_ORDER] } };
}

export const NO_GATEWAY_KEY = "No AI Gateway key. Add one in Settings.";

export type BeeGateway = GatewayProvider;

export function createBeeGateway(apiKey: string): BeeGateway {
  return createGateway({ apiKey });
}

