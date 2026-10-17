import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { describe, expect, it } from "vitest";
import { authorizeMcpServer, createMcpOAuthProvider, hasMcpOAuthTokens, type McpOAuthState, type McpOAuthStorage } from "./mcp-oauth";

const MCP_URL = "https://mcp.example.test/mcp";
const AS = "https://auth.example.test";
const REDIRECT = "http://127.0.0.1:51234/callback";

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function memoryStorage(initial?: McpOAuthState): McpOAuthStorage & { state: () => McpOAuthState | undefined } {
  let current = initial;
  return { load: () => current, save: (next) => void (current = next), state: () => current };
}

type Call = { method: string; url: string; body: string };

/** A fetch that records every call and answers from `routes` (keyed "METHOD url"). Unknown routes are 404. */
function fakeFetch(routes: Record<string, (call: Call) => Response>) {
  const calls: Call[] = [];
  const fetchFn = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const call = { method: init?.method ?? "GET", url: String(input), body: init?.body ? String(init.body) : "" };
    calls.push(call);
    return routes[`${call.method} ${call.url}`]?.(call) ?? new Response("not found", { status: 404 });
  };
  return { fetchFn, calls };
}

const asMetadata = {
  issuer: AS,
  authorization_endpoint: `${AS}/authorize`,
  token_endpoint: `${AS}/token`,
  registration_endpoint: `${AS}/register`,
  response_types_supported: ["code"],
  code_challenge_methods_supported: ["S256"],
};

describe("MCP OAuth sign-in", () => {
  it("goes from 401 to discovery, registration, PKCE authorisation and the token exchange", async () => {
    const storage = memoryStorage();
    const opened: URL[] = [];
    const provider = createMcpOAuthProvider({ storage, redirectUrl: REDIRECT, redirectToAuthorization: (url) => void opened.push(url) });
    const { fetchFn, calls } = fakeFetch({
      [`POST ${MCP_URL}`]: () =>
        new Response("", { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"` } }),
      "GET https://mcp.example.test/.well-known/oauth-protected-resource/mcp": () =>
        json({ resource: MCP_URL, authorization_servers: [AS], scopes_supported: ["openid"] }),
      [`GET ${AS}/.well-known/oauth-authorization-server`]: () => json(asMetadata),
      [`GET ${AS}/.well-known/openid-configuration`]: () => json(asMetadata),
      [`POST ${AS}/register`]: (call) => json({ ...JSON.parse(call.body), client_id: "client-1" }, 201),
      [`POST ${AS}/token`]: () => json({ access_token: "access-1", token_type: "Bearer", refresh_token: "refresh-1", expires_in: 3600 }),
    });

    // The redirect arrives only after the browser opened, as it does for a person.
    const code = new Promise<string>((resolve) => {
      const wait = setInterval(() => {
        if (opened.length > 0) {
          clearInterval(wait);
          resolve("code-1");
        }
      }, 5);
    });
    await authorizeMcpServer({ url: MCP_URL, provider, code, fetch: fetchFn });

    const registration = calls.find((call) => call.url === `${AS}/register`);
    expect(JSON.parse(registration?.body ?? "{}")).toMatchObject({
      client_name: "Bee",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });

    const authorizeUrl = opened[0] as URL;
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(`${AS}/authorize`);
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl.searchParams.get("code_challenge")).toBeTruthy();
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(authorizeUrl.searchParams.get("client_id")).toBe("client-1");
    expect(authorizeUrl.searchParams.get("state")).toBe(provider.pendingState);

    const token = new URLSearchParams(calls.find((call) => call.url === `${AS}/token`)?.body);
    expect(token.get("grant_type")).toBe("authorization_code");
    expect(token.get("code")).toBe("code-1");
    expect(token.get("code_verifier")).toBeTruthy();
    expect(token.get("redirect_uri")).toBe(REDIRECT);

    expect(storage.state()?.tokens).toMatchObject({ access_token: "access-1", refresh_token: "refresh-1" });
    expect(storage.state()?.clientInformation?.client_id).toBe("client-1");
    expect(storage.state()?.clientInformation?.issuer).toBe(AS);
    expect(storage.state()?.tokens?.issuer).toBe(AS);
    expect(hasMcpOAuthTokens(storage.state())).toBe(true);
  });

  it("refreshes with the saved refresh token and saves the new access token", async () => {
    const storage = memoryStorage({
      tokens: { access_token: "old", token_type: "Bearer", refresh_token: "refresh-1" },
      clientInformation: { client_id: "client-1", issuer: AS },
    });
    const provider = createMcpOAuthProvider({ storage });
    const { fetchFn, calls } = fakeFetch({
      "GET https://mcp.example.test/.well-known/oauth-protected-resource/mcp": () => json({ resource: MCP_URL, authorization_servers: [AS] }),
      [`GET ${AS}/.well-known/oauth-authorization-server`]: () => json(asMetadata),
      [`POST ${AS}/token`]: () => json({ access_token: "new", token_type: "Bearer", expires_in: 3600 }),
    });

    await expect(auth(provider, { serverUrl: MCP_URL, fetchFn })).resolves.toBe("AUTHORIZED");

    const token = new URLSearchParams(calls.find((call) => call.url === `${AS}/token`)?.body);
    expect(token.get("grant_type")).toBe("refresh_token");
    expect(token.get("refresh_token")).toBe("refresh-1");
    expect(storage.state()?.tokens?.access_token).toBe("new");
    // The server sent no new refresh token: the old one stays.
    expect(storage.state()?.tokens?.refresh_token).toBe("refresh-1");
  });

  it("does not throw when optional metadata is missing", async () => {
    const storage = memoryStorage({ clientInformation: { client_id: "client-1", redirect_uris: [REDIRECT], issuer: "https://mcp.example.test" } });
    const opened: URL[] = [];
    const provider = createMcpOAuthProvider({ storage, redirectUrl: REDIRECT, redirectToAuthorization: (url) => void opened.push(url) });
    // Without protected resource metadata the SDK uses the MCP origin as the authorization server, so the saved client is bound to it.
    // No protected resource metadata (404), no scopes, no registration endpoint, no PKCE list, no grant types.
    const minimal = { issuer: AS, authorization_endpoint: `${AS}/authorize`, token_endpoint: `${AS}/token`, response_types_supported: ["code"] };
    const { fetchFn } = fakeFetch({
      [`GET ${AS}/.well-known/oauth-authorization-server`]: () => json(minimal),
      "GET https://mcp.example.test/.well-known/oauth-authorization-server": () => json(minimal),
    });

    await expect(auth(provider, { serverUrl: MCP_URL, fetchFn })).resolves.toBe("REDIRECT");
    expect(opened[0]?.searchParams.get("code_challenge")).toBeTruthy();
    expect(opened[0]?.searchParams.has("scope")).toBe(false);
  });
});

describe("non-interactive provider", () => {
  it("never opens a browser or registers a client", async () => {
    const storage = memoryStorage();
    const provider = createMcpOAuthProvider({ storage });
    expect(provider.saveClientInformation).toBeUndefined();
    expect(() => provider.redirectToAuthorization(new URL(`${AS}/authorize`))).toThrow(/Connectors/);
    const { fetchFn, calls } = fakeFetch({
      "GET https://mcp.example.test/.well-known/oauth-protected-resource/mcp": () => json({ resource: MCP_URL, authorization_servers: [AS] }),
      [`GET ${AS}/.well-known/oauth-authorization-server`]: () => json(asMetadata),
    });
    await expect(auth(provider, { serverUrl: MCP_URL, fetchFn })).rejects.toThrow();
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("registers again when the saved client used another loopback port", async () => {
    const storage = memoryStorage({ clientInformation: { client_id: "client-1", redirect_uris: ["http://127.0.0.1:1111/callback"] } });
    expect(createMcpOAuthProvider({ storage, redirectUrl: REDIRECT, redirectToAuthorization: () => undefined }).clientInformation()).toBeUndefined();
    expect((await createMcpOAuthProvider({ storage }).clientInformation())?.client_id).toBe("client-1");
  });
});

describe("credentials", () => {
  it("clears tokens, client or everything on request", () => {
    const full = (): McpOAuthState => ({
      tokens: { access_token: "a", token_type: "Bearer" },
      clientInformation: { client_id: "c" },
    });
    const storage = memoryStorage(full());
    const provider = createMcpOAuthProvider({ storage });
    void provider.invalidateCredentials?.("tokens");
    expect(storage.state()).toMatchObject({ clientInformation: { client_id: "c" } });
    expect(storage.state()?.tokens).toBeUndefined();
    void provider.invalidateCredentials?.("all");
    expect(storage.state()).toBeUndefined();
  });
});
