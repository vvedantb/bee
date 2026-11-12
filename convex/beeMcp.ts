import {
  authenticateClerkBearer,
  createAuthorizationServerMetadataProxy,
  createMcpHttpHandler,
  createProtectedResourceMetadata,
  looksLikeJwt,
} from "@vvedantb/server";
import { z } from "zod";
import { BEE_LONG_POLL_MS, jobResultSchema } from "../src/shared/bee-mcp";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction, type ActionCtx } from "./_generated/server";
import { createBeeMcpDispatcher, clientNameFromUserAgent, type JobBridge, type McpPrincipal } from "./beeMcpTools";
import { AuthError, clerkIssuer, sessionVerifier } from "./clerkAuth";

// The Bee MCP server: /mcp for other AIs (Clerk OAuth, as vmem), and /bee/jobs/* for the user's Bee app (Clerk session token,
// as the relay). The tools live in beeMcpTools.ts, the job storage in beeJobs.ts. Message text is never logged.

// The metadata documents read these names (as vmem); Bee's defaults mean nothing must be set.
const metadataEnv = () => ({
  CLERK_FRONTEND_API_URL: clerkIssuer(),
  WEB_APP_URL: process.env.WEB_APP_URL || "https://github.com/vvedantb/bee",
});

export const oauthMetadata = httpAction((ctx, request) => createAuthorizationServerMetadataProxy({ env: metadataEnv() })(ctx, request));
export const protectedResourceMetadata = httpAction((ctx, request) => createProtectedResourceMetadata({ env: metadataEnv() })(ctx, request));

const clerkApiTokenSchema = z.object({ subject: z.string().min(1), revoked: z.boolean().optional(), expired: z.boolean().optional() });

/**
 * A token that is not an OAuth access token JWT: a Bee session token (verified like the relay's), or an opaque Clerk OAuth
 * token, checked with Clerk's Backend API when CLERK_SECRET_KEY is set. Null when neither verifies.
 */
async function verifyOtherToken(token: string): Promise<{ userId: string } | null> {
  if (looksLikeJwt(token)) {
    try {
      return { userId: (await sessionVerifier()(token)).userId };
    } catch (error) {
      if (error instanceof AuthError) return null;
      throw error;
    }
  }
  const secret = process.env.CLERK_SECRET_KEY;
  if (!secret) return null;
  const response = await fetch("https://api.clerk.com/v1/oauth_applications/access_tokens/verify", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ access_token: token }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) return null;
  const parsed = clerkApiTokenSchema.safeParse(await response.json());
  return parsed.success && !parsed.data.revoked && !parsed.data.expired ? { userId: parsed.data.subject } : null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The job bridge over Convex functions, for one HTTP request. */
function convexBridge(ctx: ActionCtx): JobBridge<Id<"desktopJobs">> {
  return {
    lastSeen: (clerkUserId) => ctx.runQuery(internal.beeJobs.lastSeen, { clerkUserId }),
    createJob: (job) => ctx.runMutation(internal.beeJobs.createJob, job),
    jobState: (id) => ctx.runQuery(internal.beeJobs.jobState, { id }),
    settleJob: (id) => ctx.runMutation(internal.beeJobs.settleJob, { id }),
    sleep,
    now: Date.now,
  };
}

const dispatcher = createBeeMcpDispatcher<Id<"desktopJobs">>();

export const mcpHandler = httpAction(
  createMcpHttpHandler<McpPrincipal, ActionCtx>({
    authenticate: async ({ token, request }) => {
      const verified = await authenticateClerkBearer({
        token,
        issuer: clerkIssuer(),
        verifyFallback: verifyOtherToken,
        onReject: (rejection) => console.error("[MCP] token rejected:", rejection.kind),
      });
      return verified ? { clerkUserId: verified.clerkUserId, clientName: clientNameFromUserAgent(request.headers.get("user-agent")) } : null;
    },
    handleRpc: ({ ctx, principal, json, scope }) => dispatcher.handleRpc({ ctx: convexBridge(ctx), principal, json, scope }),
  }),
);

function json(status: number, body: object): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** The Bee app's Clerk user, from its session token (Authorization: Bearer). A 401 response when it does not verify. */
async function beeUser(request: Request): Promise<{ userId: string } | Response> {
  const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token) return json(401, { error: "Sign in to Bee" });
  try {
    return { userId: (await sessionVerifier()(token)).userId };
  } catch (error) {
    return json(401, { error: error instanceof AuthError ? error.message : "Could not verify sign-in" });
  }
}

const CLAIM_EVERY_MS = 1000;

/** POST /bee/jobs/next: records that Bee runs, then waits up to BEE_LONG_POLL_MS for the oldest pending job. */
export const beeJobsNext = httpAction(async (ctx, request) => {
  const user = await beeUser(request);
  if (user instanceof Response) return user;
  await ctx.runMutation(internal.beeJobs.touchPresence, { clerkUserId: user.userId });
  const deadline = Date.now() + BEE_LONG_POLL_MS;
  for (;;) {
    const raw = await ctx.runMutation(internal.beeJobs.claimNext, { clerkUserId: user.userId });
    if (raw) {
      console.log("[bee-jobs] claimed", { id: raw.id, tool: raw.tool });
      return json(200, { job: { id: raw.id, tool: raw.tool, input: safeInput(raw.input), clientName: raw.clientName } });
    }
    if (Date.now() + CLAIM_EVERY_MS > deadline) return json(200, { job: null });
    await sleep(CLAIM_EVERY_MS);
  }
});

/** The stored JSON arguments as an object for the wire. A bad row sends an empty object, which Bee reports as unreadable. */
function safeInput(input: string): object {
  try {
    const parsed = z.record(z.string(), z.json()).safeParse(JSON.parse(input));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** POST /bee/jobs/result { id, ok, text }: Bee's result for one of this user's own running jobs. */
export const beeJobsResult = httpAction(async (ctx, request) => {
  const user = await beeUser(request);
  if (user instanceof Response) return user;
  let body: z.infer<typeof jobResultSchema>;
  try {
    body = jobResultSchema.parse(await request.json());
  } catch {
    return json(400, { error: "Expected { id, ok, text }" });
  }
  const outcome = await ctx.runMutation(internal.beeJobs.finishJob, { clerkUserId: user.userId, ...body });
  console.log("[bee-jobs] result", { id: body.id, ok: body.ok, outcome });
  return outcome === "ok" ? json(200, { ok: true }) : json(404, { error: "No such running job" });
});
