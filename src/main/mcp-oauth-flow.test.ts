import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { buildMockMcpServer } from "../../test/helpers/mock-mcp-server";
import { connectMcp } from "../core/mcp";
import { authorizeMcpServer, createMcpOAuthProvider, revokeMcpOAuth, type McpOAuthState, type McpOAuthStorage } from "../core/mcp-oauth";
import { startLoopback } from "./mcp-oauth-loopback";

// End to end over real HTTP: a fake authorization server and MCP server on 127.0.0.1, the browser played by fetch.

async function readText(request: IncomingMessage): Promise<string> {
  request.setEncoding("utf8");
  let text = "";
  for await (const chunk of request) text += String(chunk);
  return text;
}

/** One server for both roles. Access tokens are accepted until refreshed or revoked. */
async function startOAuthMcpServer() {
  const live = new Set<string>();
  const log: string[] = [];
  const revoked: Array<[string | null, string | null, string | null]> = [];
  let challenge = "";
  const http = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", origin);
      const route = `${request.method} ${url.pathname}`;
      log.push(route);
      const json = (status: number, body: object) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      if (route === "GET /.well-known/oauth-protected-resource/mcp") return json(200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
      if (route === "GET /.well-known/oauth-authorization-server") {
        return json(200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          revocation_endpoint: `${origin}/revoke`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (route === "POST /register") return json(201, { ...JSON.parse(await readText(request)), client_id: "client-e2e" });
      if (route === "GET /authorize") {
        challenge = url.searchParams.get("code_challenge") ?? "";
        const back = new URL(url.searchParams.get("redirect_uri") ?? "");
        back.searchParams.set("code", "code-e2e");
        back.searchParams.set("state", url.searchParams.get("state") ?? "");
        response.writeHead(302, { location: back.href }).end();
        return;
      }
      if (route === "POST /token") {
        const form = new URLSearchParams(await readText(request));
        const grant = form.get("grant_type");
        const verifierOk = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") === challenge;
        if (grant === "authorization_code" && form.get("code") === "code-e2e" && verifierOk) {
          live.add("access-1");
          return json(200, { access_token: "access-1", token_type: "Bearer", refresh_token: "refresh-1", expires_in: 3600 });
        }
        if (grant === "refresh_token" && form.get("refresh_token") === "refresh-1") {
          live.add("access-2");
          return json(200, { access_token: "access-2", token_type: "Bearer", refresh_token: "refresh-2", expires_in: 3600 });
        }
        return json(400, { error: "invalid_grant" });
      }
      if (route === "POST /revoke") {
        const form = new URLSearchParams(await readText(request));
        revoked.push([form.get("token"), form.get("token_type_hint"), form.get("client_id")]);
        live.delete(form.get("token") ?? "");
        response.writeHead(200).end();
        return;
      }
      if (url.pathname === "/mcp") {
        const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
        if (!live.has(token)) {
          response.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` }).end();
          return;
        }
        const server = buildMockMcpServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        response.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        const body = request.method === "POST" ? await readText(request) : "";
        await transport.handleRequest(request, response, body ? JSON.parse(body) : undefined);
        return;
      }
      response.writeHead(404).end();
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    url: `${origin}/mcp`,
    origin,
    live,
    log,
    revoked,
    close: () => new Promise<void>((resolve) => {
      http.closeAllConnections();
      http.close(() => resolve());
    }),
  };
}

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

describe("MCP OAuth end to end", () => {
  it("signs in through the loopback, refreshes on a 401, then revokes", async () => {
    const server = await startOAuthMcpServer();
    cleanup.push(server.close);
    let stored: McpOAuthState | undefined;
    const storage: McpOAuthStorage = { load: () => stored, save: (next) => void (stored = next) };

    // Sign-in: the "browser" follows the authorization redirect to the loopback.
    const loopback = await startLoopback();
    cleanup.push(loopback.close);
    const pages: string[] = [];
    const provider = createMcpOAuthProvider({
      storage,
      redirectUrl: loopback.redirectUrl,
      redirectToAuthorization: async (url) => void pages.push(await (await fetch(url)).text()),
    });
    await authorizeMcpServer({ url: server.url, provider, code: loopback.waitForCode(() => provider.pendingState) });
    loopback.close();

    expect(pages).toEqual([`<!doctype html><meta charset="utf-8"><title>Bee</title><body style="font:16px system-ui;margin:3rem"><p>You can close this window and go back to Bee.</p></body>`]);
    expect(stored).toStrictEqual({
      tokens: { access_token: "access-1", token_type: "Bearer", refresh_token: "refresh-1", expires_in: 3600, issuer: server.origin },
      clientInformation: {
        client_name: "Bee",
        redirect_uris: [loopback.redirectUrl],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_id: "client-e2e",
        issuer: server.origin,
      },
    });

    // Refresh: the access token expires on the server; the app's background connection refreshes and never opens a browser.
    server.live.delete("access-1");
    const connection = await connectMcp({ id: "e2e", name: "e2e", transport: "http", url: server.url, auth: { type: "none" }, authProvider: createMcpOAuthProvider({ storage }) });
    await connection.close();
    expect(connection.tools.map((tool) => tool.name)).toEqual(["echo", "wobble", "boom"]);
    expect(stored?.tokens).toStrictEqual({ access_token: "access-2", token_type: "Bearer", refresh_token: "refresh-2", expires_in: 3600, issuer: server.origin });
    expect(server.log.filter((route) => route === "POST /register")).toHaveLength(1);

    // Revoke: refresh token first, then the access token; the server then refuses the old access token.
    await expect(revokeMcpOAuth({ url: server.url, state: stored })).resolves.toBe(true);
    expect(server.revoked).toEqual([
      ["refresh-2", "refresh_token", "client-e2e"],
      ["access-2", "access_token", "client-e2e"],
    ]);
    await expect(connectMcp({ id: "e2e", name: "e2e", transport: "http", url: server.url, auth: { type: "none" }, authProvider: createMcpOAuthProvider({ storage }) })).rejects.toThrow(new Error("Sign in from the Connectors tab"));
    // The refresh token was revoked too, so the SDK dropped the tokens and kept the client.
    expect(stored?.tokens).toBeUndefined();
    expect(stored?.clientInformation?.client_id).toBe("client-e2e");
  });
});
