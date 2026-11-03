import { createGateway, type GatewayProvider } from "@ai-sdk/gateway";

// The model behind Luna's meeting tips, the follow-up check and meeting summaries: fast, thinking off.
export const GUIDE_MODEL = "anthropic/claude-haiku-5.5";
// The model behind direct requests to Bee ("Bee, …") and computer use: it chains tool calls and thinks briefly first.
export const COMMAND_MODEL = "anthropic/claude-sonnet-5.5";
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

// The provider Bee routes GUIDE_MODEL and COMMAND_MODEL calls to. The Gateway uses the team's own Anthropic key (BYOK) only if the team
// that owns the Gateway API key has set one up; otherwise it uses the Gateway's system credentials.
export const GUIDE_PROVIDER = "anthropic";

/**
 * Turns off extended thinking for a GUIDE_MODEL call. Haiku thinks by default: a live Luna call spent its whole
 * output budget on reasoning and returned no text. The Gateway forwards `anthropic` options to Anthropic.
 * Never send this to a non-Anthropic model (Jev, STT).
 */
export const ANTHROPIC_NO_THINKING = { anthropic: { thinking: { type: "disabled" } } } as const;

/**
 * The tier's options plus GUIDE_MODEL routing, with thinking off. Flex may not apply on Anthropic; the Gateway decides.
 * `web: true` (Luna with web_search) pins the call with `only`: Anthropic's provider-run web search may be rejected
 * by bedrock or vertex. Without web search, `order` keeps fail-over to those providers.
 */
export function guideProviderOptions(
  tier: GatewayTier,
  options: { web: boolean },
): { gateway: GatewayRouting } & typeof ANTHROPIC_NO_THINKING {
  return { gateway: anthropicRouting(tier, options), ...ANTHROPIC_NO_THINKING };
}

type GatewayRouting = { serviceTier?: string; only?: string[]; order?: string[] };

function anthropicRouting(tier: GatewayTier, options: { web: boolean }): GatewayRouting {
  const routing = options.web ? { only: [GUIDE_PROVIDER] } : { order: [GUIDE_PROVIDER] };
  return { ...gatewayTier(tier).gateway, ...routing };
}

/** Thinking tokens per command step: enough to plan the next tool call, small enough to keep replies quick. */
export const COMMAND_THINKING_BUDGET = 1500;

/**
 * Brief extended thinking for a COMMAND_MODEL call (direct requests and computer use), so the model plans before it answers or
 * calls the next tool. Thinking tokens count against maxOutputTokens, so those calls raise it. Never send to tips (GUIDE_MODEL).
 */
export const ANTHROPIC_BRIEF_THINKING = { anthropic: { thinking: { type: "enabled", budgetTokens: COMMAND_THINKING_BUDGET } } } as const;

/** Like guideProviderOptions, with brief thinking on. Cache markers stay on the messages (ANTHROPIC_CACHE). */
export function commandProviderOptions(tier: GatewayTier, options: { web: boolean }): { gateway: GatewayRouting } & typeof ANTHROPIC_BRIEF_THINKING {
  return { gateway: anthropicRouting(tier, options), ...ANTHROPIC_BRIEF_THINKING };
}

/**
 * Anthropic prompt-cache breakpoint for a GUIDE_MODEL message or content part: the prefix up to it (tools, then system,
 * then messages) is cached. The Gateway forwards `anthropic` options to Anthropic. Bee sets explicit markers instead of
 * the Gateway's `caching: "auto"`, which marks the last two messages: those hold the sliding transcript, and Anthropic
 * allows at most 4 breakpoints per request, so the two must not be combined. A prefix below the model's minimum
 * cacheable length (treat it as 4096 tokens for Haiku) is silently not cached, so a marker on a short prompt is harmless.
 * Never send this to a non-Anthropic model (Jev, STT).
 */
export const ANTHROPIC_CACHE = { anthropic: { cacheControl: { type: "ephemeral" } } } as const;

export const NO_GATEWAY_KEY = "No AI Gateway key. Add one in Settings.";

/** The models Bee takes from the Gateway. The E2E harness swaps in recording or replaying models (test/e2e/replay.ts). */
export type BeeGateway = Pick<GatewayProvider, "languageModel" | "evaluationModel" | "transcription">;

export function createBeeGateway(apiKey: string): GatewayProvider {
  return createGateway({ apiKey });
}

