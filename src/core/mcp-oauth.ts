import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { discoverAuthorizationServerMetadata, discoverOAuthServerInfo, UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";

// MCP authorization (OAuth 2.1 with PKCE and dynamic client registration) for remote servers such as vmem. No Electron imports:
// main supplies the storage, the redirect and the browser. Tokens and client information are saved by the caller, encrypted.

const tokensSchema = z.looseObject({
  access_token: z.string(),
  token_type: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  scope: z.string().optional(),
  id_token: z.string().optional(),
  // Stamped by the SDK: the authorization server these tokens came from.
  issuer: z.string().optional(),
});
const clientInformationSchema = z.looseObject({
  client_id: z.string(),
  client_secret: z.string().optional(),
  redirect_uris: z.array(z.string()).optional(),
  // Stamped by the SDK: the authorization server this client was registered with.
  issuer: z.string().optional(),
});

/** What is kept per server. Both parts carry the `issuer` they belong to, so a changed authorization server never reuses them. */
export const mcpOAuthStateSchema = z.object({
  tokens: tokensSchema.optional(),
  clientInformation: clientInformationSchema.optional(),
});
export type McpOAuthState = z.infer<typeof mcpOAuthStateSchema>;

export type McpOAuthStorage = {
  load: () => McpOAuthState | undefined;
  /** undefined clears everything for the server. */
  save: (state: McpOAuthState | undefined) => void;
};

export type McpOAuthProviderOptions = {
  storage: McpOAuthStorage;
  /** Where the browser comes back to. Set only for the interactive Connect flow: without it the provider never starts a sign-in. */
  redirectUrl?: string;
  /** Opens the authorization URL. Required with redirectUrl. */
  redirectToAuthorization?: (url: URL) => void | Promise<void>;
};

// The SDK reads "no redirect URL" as a client-credentials flow, so a provider that only refreshes still needs one. It is never sent anywhere.
const REFRESH_ONLY_REDIRECT = "http://127.0.0.1/callback";

export type McpOAuthProvider = OAuthClientProvider & {
  /** The `state` sent with the latest authorization request, for the redirect handler to check. */
  readonly pendingState: string | undefined;
};

/** True when tokens are stored, so the server counts as signed in. */
export function hasMcpOAuthTokens(state: McpOAuthState | undefined): boolean {
  return Boolean(state?.tokens?.access_token);
}

/**
 * An OAuthClientProvider over injected storage. Interactive (redirectUrl set): may register a client and open the browser.
 * Not interactive: only uses what is stored (and refreshes it), so a 401 fails fast and never opens a browser or registers a client.
 */
export function createMcpOAuthProvider(options: McpOAuthProviderOptions): McpOAuthProvider {
  const { storage, redirectUrl, redirectToAuthorization } = options;
  const interactive = Boolean(redirectUrl && redirectToAuthorization);
  let verifier: string | undefined;
  let pendingState: string | undefined;

  const update = (patch: Partial<McpOAuthState>): void => storage.save({ ...storage.load(), ...patch });

  const provider: McpOAuthProvider = {
    get redirectUrl() {
      return redirectUrl ?? REFRESH_ONLY_REDIRECT;
    },
    get clientMetadata() {
      return {
        client_name: "Bee",
        redirect_uris: redirectUrl ? [redirectUrl] : [],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      };
    },
    get pendingState() {
      return pendingState;
    },
    state() {
      pendingState = randomBytes(16).toString("base64url");
      return pendingState;
    },
    clientInformation() {
      const saved = storage.load()?.clientInformation;
      // The loopback port changes on every sign-in, so a client registered for another redirect cannot be reused.
      if (interactive && redirectUrl && saved?.redirect_uris && !saved.redirect_uris.includes(redirectUrl)) return undefined;
      return saved;
    },
    tokens() {
      return storage.load()?.tokens;
    },
    saveTokens(tokens) {
      update({ tokens });
    },
    saveCodeVerifier(value) {
      verifier = value;
    },
    codeVerifier() {
      if (!verifier) throw new Error("No code verifier saved");
      return verifier;
    },
    redirectToAuthorization(url) {
      if (!interactive || !redirectToAuthorization) throw new UnauthorizedError("Sign in from the Connectors tab");
      return redirectToAuthorization(url);
    },
    invalidateCredentials(scope) {
      if (scope === "all") storage.save(undefined);
      else if (scope === "tokens") update({ tokens: undefined });
      else if (scope === "client") update({ clientInformation: undefined });
      else if (scope === "verifier") verifier = undefined;
    },
  };
  // Without this the SDK cannot register a client, so a non-interactive 401 stops before any registration request.
  if (interactive) {
    provider.saveClientInformation = (info) => {
      const registered = (info as { redirect_uris?: string[] }).redirect_uris;
      update({ clientInformation: { ...info, redirect_uris: registered ?? (redirectUrl ? [redirectUrl] : undefined) } as McpOAuthState["clientInformation"] });
    };
  }
  return provider;
}

/**
 * Signs in to one server. Connects first; on 401 the SDK finds the protected resource metadata (RFC 9728, from WWW-Authenticate or the
 * well-known URL) and the authorization server, registers a client and calls redirectToAuthorization. Then `code` is awaited and exchanged.
 * Resolves once tokens are saved. A server that needs no sign-in resolves at once.
 */
export async function authorizeMcpServer(args: {
  url: string;
  provider: McpOAuthProvider;
  /** The authorization code from the redirect. Created before the browser opens; it may reject (cancelled, timed out). */
  code: Promise<string>;
  fetch?: FetchLike;
}): Promise<void> {
  // A rejection that arrives before we await it must not surface as unhandled.
  args.code.catch(() => undefined);
  const client = new Client({ name: "bee", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(args.url), { authProvider: args.provider, fetch: args.fetch });
  try {
    await client.connect(transport);
    return;
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
  } finally {
    await client.close().catch(() => undefined);
  }
  await transport.finishAuth(await args.code);
}

// Disconnect waits for this at most: a slow authorization server must not hold it up.
const REVOKE_TIMEOUT_MS = 3000;

/**
 * Best-effort token revocation (RFC 7009) before the local tokens are cleared. Only when the authorization server advertises a
 * `revocation_endpoint`. Never opens a browser and never throws: a missing endpoint, a network error or a 4xx/5xx is ignored.
 * Returns true when at least one token was revoked.
 */
export async function revokeMcpOAuth(args: { url: string; state: McpOAuthState | undefined; fetch?: FetchLike }): Promise<boolean> {
  const { tokens, clientInformation } = args.state ?? {};
  if (!tokens?.access_token) return false;
  const signal = AbortSignal.timeout(REVOKE_TIMEOUT_MS);
  const fetchFn: FetchLike = (input, init) => (args.fetch ?? fetch)(input, { ...init, signal });
  try {
    // The stored issuer is the server the tokens came from; without one, discover it from the MCP server.
    const issuer = tokens.issuer ?? clientInformation?.issuer;
    const metadata = issuer
      ? await discoverAuthorizationServerMetadata(issuer, { fetchFn })
      : (await discoverOAuthServerInfo(args.url, { fetchFn })).authorizationServerMetadata;
    // The OpenID metadata type has no field for it, though a server may send one.
    const endpoint = (metadata as { revocation_endpoint?: string } | undefined)?.revocation_endpoint;
    if (!endpoint) return false;
    const revoke = async (token: string, hint: string): Promise<boolean> => {
      const body = new URLSearchParams({ token, token_type_hint: hint });
      if (clientInformation?.client_id) body.set("client_id", clientInformation.client_id);
      if (clientInformation?.client_secret) body.set("client_secret", clientInformation.client_secret);
      const response = await fetchFn(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
      return response.ok;
    };
    // The refresh token first: revoking it may also end the access token, and it is the longer-lived one.
    const outcomes = await Promise.all([
      ...(tokens.refresh_token ? [revoke(tokens.refresh_token, "refresh_token")] : []),
      revoke(tokens.access_token, "access_token"),
    ].map((work) => work.catch(() => false)));
    return outcomes.some(Boolean);
  } catch {
    return false;
  }
}
