import { auth, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { describe, expect, it } from "vitest";
import { authorizeMcpServer, createMcpOAuthProvider, hasMcpOAuthTokens, mcpOAuthStateSchema, revokeMcpOAuth, type McpOAuthState, type McpOAuthStorage } from "./mcp-oauth";

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

  it("registers and signs in a custom server (not vmem) through the same flow", async () => {
    const eva = "https://eva.example.test/mcp";
    const storage = memoryStorage();
    const provider = createMcpOAuthProvider({ storage, redirectUrl: REDIRECT, redirectToAuthorization: () => undefined });
    const { fetchFn, calls } = fakeFetch({
      [`POST ${eva}`]: () => new Response("", { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="https://eva.example.test/.well-known/oauth-protected-resource"` } }),
      "GET https://eva.example.test/.well-known/oauth-protected-resource": () => json({ resource: eva, authorization_servers: ["https://eva.example.test"] }),
      "GET https://eva.example.test/.well-known/oauth-authorization-server": () =>
        json({ ...asMetadata, issuer: "https://eva.example.test", authorization_endpoint: "https://eva.example.test/authorize", token_endpoint: "https://eva.example.test/token", registration_endpoint: "https://eva.example.test/mcp/oauth/register" }),
      "POST https://eva.example.test/mcp/oauth/register": (call) => json({ ...JSON.parse(call.body), client_id: "eva-client" }, 201),
      "POST https://eva.example.test/token": () => json({ access_token: "eva-access", token_type: "Bearer", refresh_token: "eva-refresh" }),
    });

    await authorizeMcpServer({ url: eva, provider, code: Promise.resolve("code-eva"), fetch: fetchFn });

    expect(calls.some((call) => call.url === "https://eva.example.test/mcp/oauth/register")).toBe(true);
    expect(storage.state()?.clientInformation?.client_id).toBe("eva-client");
    expect(storage.state()?.tokens).toMatchObject({ access_token: "eva-access", refresh_token: "eva-refresh" });
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
  it("never opens a browser, and a 401 does not hit the saveable-client error", async () => {
    const storage = memoryStorage();
    const provider = createMcpOAuthProvider({ storage });
    expect(provider.saveClientInformation).toBeDefined();
    expect(() => provider.redirectToAuthorization(new URL(`${AS}/authorize`))).toThrow(/Connectors/);
    const { fetchFn, calls } = fakeFetch({
      "GET https://mcp.example.test/.well-known/oauth-protected-resource/mcp": () => json({ resource: MCP_URL, authorization_servers: [AS] }),
      [`GET ${AS}/.well-known/oauth-authorization-server`]: () => json(asMetadata),
      [`POST ${AS}/register`]: (call) => json({ ...JSON.parse(call.body), client_id: "client-1" }, 201),
    });
    const failure = await auth(provider, { serverUrl: MCP_URL, fetchFn }).catch((error: unknown) => error);
    expect(String(failure)).toMatch(/Connectors/);
    expect(String(failure)).not.toMatch(/saveable/);
    expect(calls.some((call) => call.url.endsWith("/token"))).toBe(false);
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

describe("revokeMcpOAuth", () => {
  const state: McpOAuthState = {
    tokens: { access_token: "AT", refresh_token: "RT", token_type: "Bearer", issuer: AS },
    clientInformation: { client_id: "client-1", issuer: AS },
  };
  const metadataRoute = (extra: Record<string, unknown>) => ({ [`GET ${AS}/.well-known/oauth-authorization-server`]: () => json({ ...asMetadata, ...extra }) });

  it("posts the refresh and access tokens to the advertised revocation_endpoint", async () => {
    const { fetchFn, calls } = fakeFetch({ ...metadataRoute({ revocation_endpoint: `${AS}/revoke` }), [`POST ${AS}/revoke`]: () => new Response(null, { status: 200 }) });
    await expect(revokeMcpOAuth({ url: MCP_URL, state, fetch: fetchFn })).resolves.toBe(true);
    const posts = calls.filter((call) => call.method === "POST").map((call) => new URLSearchParams(call.body));
    expect(posts.map((body) => [body.get("token"), body.get("token_type_hint"), body.get("client_id")])).toEqual([
      ["RT", "refresh_token", "client-1"],
      ["AT", "access_token", "client-1"],
    ]);
  });

  it("skips when the server advertises no revocation_endpoint, or nobody is signed in", async () => {
    const { fetchFn, calls } = fakeFetch(metadataRoute({}));
    await expect(revokeMcpOAuth({ url: MCP_URL, state, fetch: fetchFn })).resolves.toBe(false);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    const none = fakeFetch({});
    await expect(revokeMcpOAuth({ url: MCP_URL, state: undefined, fetch: none.fetchFn })).resolves.toBe(false);
    expect(none.calls).toEqual([]);
  });

  it("never throws when revocation fails with a 500 or a network error", async () => {
    const failing = fakeFetch({ ...metadataRoute({ revocation_endpoint: `${AS}/revoke` }), [`POST ${AS}/revoke`]: () => new Response("down", { status: 500 }) });
    await expect(revokeMcpOAuth({ url: MCP_URL, state, fetch: failing.fetchFn })).resolves.toBe(false);
    const offline = async (): Promise<Response> => Promise.reject(new Error("offline"));
    await expect(revokeMcpOAuth({ url: MCP_URL, state, fetch: offline })).resolves.toBe(false);
  });
});

// Pins the exact current behaviour (stored state, registration, errors, revocation requests) so the switch to the shared package cannot drift.
describe("pinned behaviour", () => {
  const unauthorised = () => new Response("", { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"` } });
  const discovery = {
    "GET https://mcp.example.test/.well-known/oauth-protected-resource/mcp": () => json({ resource: MCP_URL, authorization_servers: [AS] }),
    [`GET ${AS}/.well-known/oauth-authorization-server`]: () => json(asMetadata),
  };

  it("parses the stored state: token and client extras kept, other top-level keys dropped", () => {
    const stored = {
      tokens: { access_token: "a", token_type: "Bearer", refresh_token: "r", expires_in: 60, issuer: AS, extra: 1, obtained_at: "not a number" },
      clientInformation: { client_id: "c", client_secret: "s", redirect_uris: [REDIRECT], issuer: AS, client_name: "Bee" },
      identity: { email: "someone@example.test" },
      other: true,
    };
    expect(mcpOAuthStateSchema.parse(stored)).toStrictEqual({ tokens: stored.tokens, clientInformation: stored.clientInformation });
    expect(mcpOAuthStateSchema.parse({})).toStrictEqual({});
    expect(mcpOAuthStateSchema.safeParse({ tokens: { access_token: "a" } }).success).toBe(false);
    expect(mcpOAuthStateSchema.safeParse({ clientInformation: {} }).success).toBe(false);
  });

  it("stores exactly the SDK tokens and the registered client after sign-in, with no expiry stamp", async () => {
    const storage = memoryStorage();
    const provider = createMcpOAuthProvider({ storage, redirectUrl: REDIRECT, redirectToAuthorization: () => undefined });
    const { fetchFn, calls } = fakeFetch({
      [`POST ${MCP_URL}`]: unauthorised,
      ...discovery,
      [`POST ${AS}/register`]: (call) => json({ ...JSON.parse(call.body), client_id: "client-1", client_id_issued_at: 1 }, 201),
      [`POST ${AS}/token`]: () => json({ access_token: "access-1", token_type: "Bearer", refresh_token: "refresh-1", expires_in: 3600, scope: "openid" }),
    });
    await authorizeMcpServer({ url: MCP_URL, provider, code: Promise.resolve("code-1"), fetch: fetchFn });

    expect(JSON.parse(calls.find((call) => call.url === `${AS}/register`)?.body ?? "{}")).toStrictEqual({
      client_name: "Bee",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    expect(storage.state()).toStrictEqual({
      tokens: { access_token: "access-1", token_type: "Bearer", refresh_token: "refresh-1", expires_in: 3600, scope: "openid", issuer: AS },
      clientInformation: {
        client_name: "Bee",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_id: "client-1",
        client_id_issued_at: 1,
        issuer: AS,
      },
    });
    // The MCP client introduces itself as bee 1.0.0.
    const initialize = calls.find((call) => call.url === MCP_URL && call.method === "POST");
    expect(JSON.parse(initialize?.body ?? "{}").params.clientInfo).toStrictEqual({ name: "bee", version: "1.0.0" });
  });

  it("exposes the client metadata and redirect for both kinds of provider", () => {
    const storage = memoryStorage();
    const interactive = createMcpOAuthProvider({ storage, redirectUrl: REDIRECT, redirectToAuthorization: () => undefined });
    const background = createMcpOAuthProvider({ storage });
    expect(interactive.redirectUrl).toBe(REDIRECT);
    expect(background.redirectUrl).toBe("http://127.0.0.1/callback");
    const metadata = { client_name: "Bee", token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] };
    expect(interactive.clientMetadata).toStrictEqual({ ...metadata, redirect_uris: [REDIRECT] });
    expect(background.clientMetadata).toStrictEqual({ ...metadata, redirect_uris: [] });
  });

  it("a non-interactive provider registers on a 401, saves the client, then fails with the Connectors message", async () => {
    const storage = memoryStorage();
    const provider = createMcpOAuthProvider({ storage });
    const { fetchFn, calls } = fakeFetch({ ...discovery, [`POST ${AS}/register`]: (call) => json({ ...JSON.parse(call.body), client_id: "client-1" }, 201) });
    const attempt = auth(provider, { serverUrl: MCP_URL, fetchFn });
    await expect(attempt).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(attempt).rejects.toThrow(new Error("Sign in from the Connectors tab"));
    expect(calls.filter((call) => call.method === "POST").map((call) => call.url)).toEqual([`${AS}/register`]);
    expect(storage.state()).toStrictEqual({
      clientInformation: {
        client_name: "Bee",
        redirect_uris: [],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_id: "client-1",
        issuer: AS,
      },
    });
  });

  it("fills redirect_uris on a saved client only when the server left them out", () => {
    const storage = memoryStorage();
    void createMcpOAuthProvider({ storage, redirectUrl: REDIRECT, redirectToAuthorization: () => undefined }).saveClientInformation?.({ client_id: "a" });
    expect(storage.state()).toStrictEqual({ clientInformation: { client_id: "a", redirect_uris: [REDIRECT] } });
    void createMcpOAuthProvider({ storage }).saveClientInformation?.({ client_id: "b" });
    expect(storage.state()).toStrictEqual({ clientInformation: { client_id: "b", redirect_uris: undefined } });
    void createMcpOAuthProvider({ storage }).saveClientInformation?.({ client_id: "c", redirect_uris: ["x"] });
    expect(storage.state()).toStrictEqual({ clientInformation: { client_id: "c", redirect_uris: ["x"] } });
  });

  it("saves tokens as given, keeping the client", () => {
    const storage = memoryStorage({ clientInformation: { client_id: "c" } });
    void createMcpOAuthProvider({ storage }).saveTokens({ access_token: "a", token_type: "Bearer", expires_in: 60 });
    expect(storage.state()).toStrictEqual({ clientInformation: { client_id: "c" }, tokens: { access_token: "a", token_type: "Bearer", expires_in: 60 } });
    expect(hasMcpOAuthTokens({ tokens: { access_token: "", token_type: "Bearer" } })).toBe(false);
    expect(hasMcpOAuthTokens(undefined)).toBe(false);
  });

  it("refreshes an expired token on a 401 and keeps the stored format", async () => {
    const storage = memoryStorage({
      tokens: { access_token: "old", token_type: "Bearer", refresh_token: "refresh-1", expires_in: 1, issuer: AS },
      clientInformation: { client_id: "client-1", issuer: AS },
    });
    const { fetchFn } = fakeFetch({ ...discovery, [`POST ${AS}/token`]: () => json({ access_token: "new", token_type: "Bearer", refresh_token: "refresh-2", expires_in: 3600 }) });
    await expect(auth(createMcpOAuthProvider({ storage }), { serverUrl: MCP_URL, fetchFn })).resolves.toBe("AUTHORIZED");
    expect(storage.state()).toStrictEqual({
      tokens: { access_token: "new", token_type: "Bearer", refresh_token: "refresh-2", expires_in: 3600, issuer: AS },
      clientInformation: { client_id: "client-1", issuer: AS },
    });
  });

  it("makes a fresh base64url state per request and keeps the code verifier in memory only", () => {
    const storage = memoryStorage();
    const provider = createMcpOAuthProvider({ storage, redirectUrl: REDIRECT, redirectToAuthorization: () => undefined });
    expect(provider.pendingState).toBeUndefined();
    const first = provider.state?.();
    expect(first).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(provider.pendingState).toBe(first);
    expect(provider.state?.()).not.toBe(first);
    expect(() => provider.codeVerifier()).toThrow(new Error("No code verifier saved"));
    void provider.saveCodeVerifier("v1");
    expect(provider.codeVerifier()).toBe("v1");
    void provider.invalidateCredentials?.("verifier");
    expect(() => provider.codeVerifier()).toThrow("No code verifier saved");
    expect(storage.state()).toBeUndefined();
  });

  it("clears only the client on request", () => {
    const storage = memoryStorage({ tokens: { access_token: "a", token_type: "Bearer" }, clientInformation: { client_id: "c" } });
    void createMcpOAuthProvider({ storage }).invalidateCredentials?.("client");
    expect(storage.state()).toStrictEqual({ tokens: { access_token: "a", token_type: "Bearer" }, clientInformation: undefined });
  });

  it("hands the authorization URL to the opener and returns what it returns", async () => {
    const opened: string[] = [];
    const provider = createMcpOAuthProvider({ storage: memoryStorage(), redirectUrl: REDIRECT, redirectToAuthorization: async (url) => void opened.push(url.href) });
    await provider.redirectToAuthorization(new URL(`${AS}/authorize?x=1`));
    expect(opened).toEqual([`${AS}/authorize?x=1`]);
    // redirectUrl alone is not interactive.
    expect(() => createMcpOAuthProvider({ storage: memoryStorage(), redirectUrl: REDIRECT }).redirectToAuthorization(new URL(AS))).toThrow(new UnauthorizedError("Sign in from the Connectors tab"));
  });

  it("passes a cancelled sign-in through, and never leaves an early rejection unhandled", async () => {
    const provider = createMcpOAuthProvider({ storage: memoryStorage(), redirectUrl: REDIRECT, redirectToAuthorization: () => undefined });
    const { fetchFn } = fakeFetch({ [`POST ${MCP_URL}`]: unauthorised, ...discovery, [`POST ${AS}/register`]: (call) => json({ ...JSON.parse(call.body), client_id: "client-1" }, 201) });
    await expect(authorizeMcpServer({ url: MCP_URL, provider, code: Promise.reject(new Error("Sign-in was cancelled")), fetch: fetchFn })).rejects.toThrow(new Error("Sign-in was cancelled"));
  });

  it("resolves without a code when the server needs no sign-in", async () => {
    const provider = createMcpOAuthProvider({ storage: memoryStorage(), redirectUrl: REDIRECT, redirectToAuthorization: () => undefined });
    const { fetchFn, calls } = fakeFetch({
      [`POST ${MCP_URL}`]: (call) => {
        const message = JSON.parse(call.body);
        if (message.method !== "initialize") return new Response(null, { status: 202 });
        return json({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: {}, serverInfo: { name: "open", version: "1" } } });
      },
      [`GET ${MCP_URL}`]: () => new Response(null, { status: 405 }),
    });
    await expect(authorizeMcpServer({ url: MCP_URL, provider, code: new Promise<string>(() => undefined), fetch: fetchFn })).resolves.toBeUndefined();
    expect(calls.some((call) => call.url.startsWith(AS))).toBe(false);
  });

  it("revokes with the exact request format, client secret included", async () => {
    const requests: Array<{ url: string; method: string; headers: RequestInit["headers"]; body: string; signal: boolean }> = [];
    const fetchFn = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url === `${AS}/.well-known/oauth-authorization-server`) return json({ ...asMetadata, revocation_endpoint: `${AS}/revoke` });
      requests.push({ url, method: init?.method ?? "GET", headers: init?.headers, body: String(init?.body), signal: init?.signal instanceof AbortSignal });
      return new Response(null, { status: url.endsWith("revoke") && String(init?.body).includes("refresh") ? 400 : 200 });
    };
    const withSecret: McpOAuthState = {
      tokens: { access_token: "AT", refresh_token: "RT", token_type: "Bearer", issuer: AS },
      clientInformation: { client_id: "client-1", client_secret: "shh" },
    };
    // One of the two succeeded.
    await expect(revokeMcpOAuth({ url: MCP_URL, state: withSecret, fetch: fetchFn })).resolves.toBe(true);
    expect(requests).toEqual([
      { url: `${AS}/revoke`, method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "token=RT&token_type_hint=refresh_token&client_id=client-1&client_secret=shh", signal: true },
      { url: `${AS}/revoke`, method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "token=AT&token_type_hint=access_token&client_id=client-1&client_secret=shh", signal: true },
    ]);
  });

  it("revokes the access token alone, and finds the authorization server from the MCP server when no issuer is stored", async () => {
    const { fetchFn, calls } = fakeFetch({
      "GET https://mcp.example.test/.well-known/oauth-protected-resource/mcp": () => json({ resource: MCP_URL, authorization_servers: [AS] }),
      [`GET ${AS}/.well-known/oauth-authorization-server`]: () => json({ ...asMetadata, revocation_endpoint: `${AS}/revoke` }),
      [`POST ${AS}/revoke`]: () => new Response(null, { status: 200 }),
    });
    await expect(revokeMcpOAuth({ url: MCP_URL, state: { tokens: { access_token: "AT", token_type: "Bearer" } }, fetch: fetchFn })).resolves.toBe(true);
    expect(calls.filter((call) => call.method === "POST").map((call) => call.body)).toEqual(["token=AT&token_type_hint=access_token"]);
    expect(calls[0]?.url).toBe("https://mcp.example.test/.well-known/oauth-protected-resource/mcp");
  });

  it("does nothing without an access token", async () => {
    const { fetchFn, calls } = fakeFetch({});
    await expect(revokeMcpOAuth({ url: MCP_URL, state: { clientInformation: { client_id: "c" } }, fetch: fetchFn })).resolves.toBe(false);
    expect(calls).toEqual([]);
  });
});
