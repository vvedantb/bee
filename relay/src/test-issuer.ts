import { createJwksVerifier, type VerifyToken } from "./jwt";

// Test-only Clerk stand-in: an RS256 key pair, its JWKS, and a signer. Used by unit tests and the Teams E2E.

export const TEST_ISSUER = "https://clerk.vedantb.com";

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export async function createTestIssuer(kid = "test-key") {
  const keys = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const jwks = { keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }] };

  async function sign(claims: Record<string, string | number>, headerKid = kid): Promise<string> {
    const encode = (value: object) => base64Url(new TextEncoder().encode(JSON.stringify(value)));
    const input = `${encode({ alg: "RS256", kid: headerKid, typ: "JWT" })}.${encode(claims)}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(input));
    return `${input}.${base64Url(new Uint8Array(signature))}`;
  }

  /** A live session token for user, as Clerk would issue it (10 minutes). */
  function token(userId: string, extra: Record<string, string | number> = {}): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return sign({ iss: TEST_ISSUER, sub: userId, iat: now, nbf: now, exp: now + 600, ...extra });
  }

  const jwksFetch: typeof globalThis.fetch = async () => Response.json(jwks);
  const verify: VerifyToken = createJwksVerifier({ issuer: TEST_ISSUER, jwksUrl: "https://test.invalid/jwks", fetch: jwksFetch });

  return { jwks, sign, token, verify, jwksFetch };
}
