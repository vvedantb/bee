import { createGateway, type GatewayProvider } from "@ai-sdk/gateway";

// The model behind Luna's meeting tips, the follow-up check and meeting summaries: fast, thinking off.
export const GUIDE_MODEL = "anthropic/claude-haiku-5.5";
// The model behind direct requests to Bee ("Bee, …") and computer use: it chains tool calls and thinks first.
export const COMMAND_MODEL = "anthropic/claude-sonnet-5.5";
// Context windows in tokens, from the Gateway catalog (ai-gateway.vercel.sh/v1/models) and Anthropic's docs. The 1M window is native
// and the default for Sonnet 5.5 and Haiku 5.5: no beta header or provider option unlocks it, and the legacy context-1m-* beta header
// must not be sent (Anthropic's Sonnet 5.5 migration guide says to remove it). Sonnet 5.5 has flat pricing across the window;
// Haiku 5.5 bills input over 100k tokens at a higher tier (Gateway input_tiers), but its window is still 1M.
export const COMMAND_CONTEXT_TOKENS = 1_000_000;
export const GUIDE_CONTEXT_TOKENS = 1_000_000;
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
 * Thinking for a COMMAND_MODEL call (direct requests and computer use), so the model plans before it answers or calls the next
 * tool. COMMAND_MODEL (claude-sonnet-5*) always thinks adaptively: the installed @ai-sdk/anthropic marks it
 * supportsAdaptiveThinking, warns that budget-based thinking ({ type: "enabled", budgetTokens }) is not supported and rewrites it
 * to adaptive (the 0.3.36 debug log had that warning on every step). So the depth is set with `effort`, not a token budget:
 * "medium" (not "high") balances planning depth against latency and thinking tokens. Checked against the installed package's
 * model caps and option schema; no live Gateway call (no key in CI). Thinking tokens count against maxOutputTokens, so those calls raise it. Never send to tips (GUIDE_MODEL).
 */
export const ANTHROPIC_COMMAND_THINKING = { anthropic: { thinking: { type: "adaptive" }, effort: "medium" } } as const;

/**
 * How hard a COMMAND_MODEL call thinks: medium by default; low for a short computer-use task (one target, no later step:
 * core/computer-use.ts shortComputerTask), where each step is a plain look or act and thinking adds seconds a turn. Only these
 * two: never high on the path to an answer.
 */
export type CommandEffort = "low" | "medium";

/**
 * Like guideProviderOptions, with adaptive thinking at medium effort, or low when asked. Cache markers stay on the messages
 * (ANTHROPIC_CACHE).
 */
export function commandProviderOptions(
  tier: GatewayTier,
  options: { web: boolean; effort?: CommandEffort },
): { gateway: GatewayRouting; anthropic: { thinking: { type: "adaptive" }; effort: CommandEffort } } {
  return { gateway: anthropicRouting(tier, options), anthropic: { ...ANTHROPIC_COMMAND_THINKING.anthropic, effort: options.effort ?? "medium" } };
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

