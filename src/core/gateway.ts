import { createGateway, type GatewayProvider } from "@ai-sdk/gateway";

// The model behind Luna's meeting tips, the follow-up check, meeting summaries and the history summary: fast, thinking off.
// Direct requests to Bee ("Bee, …") and computer use do not use the Gateway: they run on the user's own Claude account
// (core/claude-agent.ts AGENT_MODEL).
export const GUIDE_MODEL = "anthropic/claude-haiku-5.5";
// Context windows in tokens, from the Gateway catalog (ai-gateway.vercel.sh/v1/models) and Anthropic's docs. The 1M window is native
// and the default for Sonnet 5.5 and Haiku 5.5: no beta header or provider option unlocks it, and the legacy context-1m-* beta header
// must not be sent (Anthropic's Sonnet 5.5 migration guide says to remove it). Sonnet 5.5 has flat pricing across the window;
// Haiku 5.5 bills input over 100k tokens at a higher tier (Gateway input_tiers), but its window is still 1M. COMMAND_CONTEXT_TOKENS is
// the agent's Sonnet 5.5 window, for compacting Bee's history (core/bee-history.ts).
export const COMMAND_CONTEXT_TOKENS = 1_000_000;
export const GUIDE_CONTEXT_TOKENS = 1_000_000;
export const JEV_MODEL = "typesafe-ai/jev";
// Speech-to-text. Voxtral Small takes a list of words to listen for (core/transcribe.ts sttVocabulary), which fixes most misheard
// names. Picked on a 30-clip name-heavy benchmark (06 Nov 2026): 1.8% word errors with Bee's terms as hints, against 7.5% for
// xai/grok-stt, at $0.0040/min against $0.0017/min.
export const STT_MODEL = "mistral/voxtral-small-transcribe-3";

// Service tier is a per-call choice. No sampling parameters are ever sent to the Gateway.
//  - "flex": cheaper, may queue and be slower. For background work only (summary, link ranking, Jev ranking).
//  - "default": the Gateway's standard tier (no serviceTier sent). User-facing STT and Luna use it: they sit on the
//    path between the end of speech and the first tip, so a flex queue shows up as felt latency.
//  - "ultrafast": NOT used. It may be rejected by these models (STT_MODEL, anthropic/claude-haiku-5.5), and no call in this repo
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
 * Haiku 5.5 accepts `disabled`: the installed @ai-sdk/anthropic `getModelCapabilities` has no claude-haiku-5 entry that forces
 * adaptive thinking (only Opus 5.x, Fable 5.x and Sonnet 5 strip `disabled`), so this stays the fast path for tips, the
 * follow-up check, meeting summaries and the history summariser. Do not switch them to adaptive thinking with effort.
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

