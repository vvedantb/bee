import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { authorizeMcpServer as authorize, createMcpOAuthProvider as createProvider, type McpOAuthProvider, type McpOAuthStorage } from "@vvedantb/mcp-client";
import { z } from "zod";

// MCP authorization (OAuth 2.1 with PKCE and dynamic client registration) for remote servers such as vmem, from @vvedantb/mcp-client
// with Bee's options. No Electron imports: main supplies the storage, the redirect and the browser. The caller saves the state, encrypted.

export { hasMcpOAuthTokens, revokeMcpOAuth, type McpOAuthProvider, type McpOAuthStorage } from "@vvedantb/mcp-client";

// Kept local: the package schema also keeps an `identity` and checks `obtained_at`, which would change how stored settings parse.
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

export type McpOAuthProviderOptions = {
  storage: McpOAuthStorage;
  /** Where the browser comes back to. Set only for the interactive Connect flow: without it the provider never starts a sign-in. */
  redirectUrl?: string;
  /** Opens the authorization URL. Required with redirectUrl. */
  redirectToAuthorization?: (url: URL) => void | Promise<void>;
};

/**
 * Interactive (redirectUrl set): may register a client and open the browser. Not interactive: uses what is stored (and refreshes it);
 * a 401 that needs a new sign-in fails fast with "Sign in from the Connectors tab". Both can save client information, so dynamic
 * registration never fails for want of somewhere to keep the result. Tokens are saved as the SDK returns them (no `obtained_at`).
 */
export function createMcpOAuthProvider(options: McpOAuthProviderOptions): McpOAuthProvider {
  return createProvider({ ...options, clientName: "Bee", signInRequiredMessage: "Sign in from the Connectors tab", clientRegistration: "always", stampObtainedAt: false });
}

/** Signs in to one server: connects as bee 1.0.0 first, and on 401 awaits `code` and exchanges it. A server that needs no sign-in resolves at once. */
export function authorizeMcpServer(args: { url: string; provider: McpOAuthProvider; code: Promise<string>; fetch?: FetchLike }): Promise<void> {
  return authorize({ ...args, connectAs: { name: "bee", version: "1.0.0" } });
}
