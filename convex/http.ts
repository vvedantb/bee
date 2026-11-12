import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { registerMcpRoutes } from "@vvedantb/server";
import { beeJobsNext, beeJobsResult, mcpHandler, oauthMetadata, protectedResourceMetadata } from "./beeMcp";
import { AuthError, sessionVerifier } from "./clerkAuth";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
};

function jsonResponse(status: number, body: string | object): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

const relayHttp = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(request.url);
  if (url.pathname === "/health" || url.pathname === "/health/") {
    return jsonResponse(200, { ok: true, serverNow: Date.now() });
  }

  const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token) return jsonResponse(401, { error: "Sign in to Bee to sync" });

  let identity;
  try {
    identity = await sessionVerifier()(token);
  } catch (error) {
    return jsonResponse(401, {
      error: error instanceof AuthError ? error.message : "Could not verify sign-in",
    });
  }

  const bodyText =
    request.method === "GET" || request.method === "HEAD" ? null : await request.text();

  try {
    const result = await ctx.runMutation(internal.relay.dispatch, {
      method: request.method,
      path: url.pathname.replace(/\/+$/, "") || "/",
      search: url.search,
      bodyText: bodyText === "" ? null : bodyText,
      userId: identity.userId,
      name: identity.name,
    });
    return new Response(result.body, {
      status: result.status,
      headers: { "content-type": "application/json", ...CORS },
    });
  } catch (error) {
    console.error("relay dispatch failed", error);
    return jsonResponse(500, { error: "Relay error" });
  }
});

const http = httpRouter();

// Mirror the Worker surface: /health and every /v1/* method the client uses.
for (const method of ["GET", "POST", "PUT", "OPTIONS"] as const) {
  http.route({ pathPrefix: "/v1/", method, handler: relayHttp });
  http.route({ path: "/health", method, handler: relayHttp });
}

// Bee MCP server (beeMcp.ts): /mcp and its OAuth metadata for other AIs, and the job routes the Bee app polls.
registerMcpRoutes(http, {
  authorizationServerMetadata: oauthMetadata,
  protectedResourceMetadata,
  endpoints: [{ handler: mcpHandler, protectedResourceMetadata }],
});
http.route({ path: "/bee/jobs/next", method: "POST", handler: beeJobsNext });
http.route({ path: "/bee/jobs/result", method: "POST", handler: beeJobsResult });

export default http;
