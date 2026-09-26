import { z } from "zod";

// Clerk session token verification with WebCrypto (works in Workers and Node 22): RS256 signature against the
// instance JWKS, then issuer, expiry, not-before and (optionally) authorised party.

export type Identity = { userId: string; name: string | null };
export type VerifyToken = (token: string) => Promise<Identity>;

export class AuthError extends Error {}

const headerSchema = z.object({ alg: z.literal("RS256"), kid: z.string().min(1) });
const claimsSchema = z.object({
  iss: z.string(),
  sub: z.string().min(1),
  exp: z.number(),
  nbf: z.number().optional(),
  azp: z.string().optional(),
  // Optional custom claim (Clerk session token template: {"name": "{{user.full_name}}"}).
  name: z.string().nullish(),
});
const jwkSchema = z.object({ kid: z.string(), kty: z.literal("RSA"), n: z.string(), e: z.string() });
const jwksSchema = z.object({ keys: z.array(z.looseObject({ kid: z.string().optional(), kty: z.string() })) });

const JWKS_TTL_MS = 10 * 60_000;
// Refetch at most this often when a token names a kid we do not have (key rotation).
const JWKS_REFETCH_MS = 30_000;
const CLOCK_SKEW_S = 5;

function base64UrlBytes(input: string): Uint8Array<ArrayBuffer> {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function decodeJson(part: string): object {
  return JSON.parse(new TextDecoder().decode(base64UrlBytes(part)));
}

export function createJwksVerifier(args: {
  issuer: string;
  jwksUrl?: string;
  // Allowed azp values; empty or missing skips the check.
  authorizedParties?: string[];
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}): VerifyToken {
  const jwksUrl = args.jwksUrl || `${args.issuer.replace(/\/+$/, "")}/.well-known/jwks.json`;
  const fetchImpl = args.fetch ?? globalThis.fetch;
  const now = args.now ?? Date.now;
  let keys = new Map<string, CryptoKey>();
  let fetchedAt = 0;

  async function refresh(): Promise<void> {
    fetchedAt = now();
    const response = await fetchImpl(jwksUrl, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new AuthError(`JWKS fetch failed: ${response.status}`);
    const next = new Map<string, CryptoKey>();
    for (const raw of jwksSchema.parse(await response.json()).keys) {
      const jwk = jwkSchema.safeParse(raw);
      if (!jwk.success) continue;
      const { kid, kty, n, e } = jwk.data;
      next.set(kid, await crypto.subtle.importKey("jwk", { kty, n, e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
    }
    keys = next;
  }

  async function keyFor(kid: string): Promise<CryptoKey> {
    const stale = now() - fetchedAt > JWKS_TTL_MS;
    if (stale || (!keys.has(kid) && now() - fetchedAt > JWKS_REFETCH_MS)) await refresh();
    const key = keys.get(kid);
    if (!key) throw new AuthError("Unknown signing key");
    return key;
  }

  return async (token) => {
    const [headerPart, payloadPart, signaturePart, extra] = token.split(".");
    if (!headerPart || !payloadPart || !signaturePart || extra !== undefined) throw new AuthError("Malformed token");
    let header: z.infer<typeof headerSchema>;
    let claims: z.infer<typeof claimsSchema>;
    try {
      header = headerSchema.parse(decodeJson(headerPart));
      claims = claimsSchema.parse(decodeJson(payloadPart));
    } catch {
      throw new AuthError("Malformed token");
    }
    const key = await keyFor(header.kid);
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      base64UrlBytes(signaturePart),
      new TextEncoder().encode(`${headerPart}.${payloadPart}`),
    );
    if (!valid) throw new AuthError("Bad signature");
    const seconds = now() / 1000;
    if (claims.iss !== args.issuer) throw new AuthError("Wrong issuer");
    if (claims.exp + CLOCK_SKEW_S <= seconds) throw new AuthError("Token expired");
    if (claims.nbf !== undefined && claims.nbf - CLOCK_SKEW_S > seconds) throw new AuthError("Token not yet valid");
    const parties = args.authorizedParties ?? [];
    if (parties.length > 0 && (!claims.azp || !parties.includes(claims.azp))) throw new AuthError("Unauthorised party");
    return { userId: claims.sub, name: claims.name?.trim() || null };
  };
}
