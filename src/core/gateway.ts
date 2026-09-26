import { createGateway, type GatewayProvider } from "@ai-sdk/gateway";

export const LUNA_MODEL = "openai/gpt-6-luna";
export const JEV_MODEL = "typesafe-ai/jev";

// Flex tier: cheaper, may be slower. No sampling parameters are ever sent to the Gateway.
export const FLEX_PROVIDER_OPTIONS = { gateway: { serviceTier: "flex" } };

export type BeeGateway = GatewayProvider;

export function createBeeGateway(apiKey: string): BeeGateway {
  return createGateway({ apiKey });
}

