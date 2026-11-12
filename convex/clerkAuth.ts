import { createJwksVerifier, type VerifyToken } from "../relay/src/jwt";

export { createJwksVerifier, AuthError, type Identity, type VerifyToken } from "../relay/src/jwt";

/** Bee's Clerk instance. CLERK_FRONTEND_API_URL (vmem's name) or CLERK_ISSUER override it; no trailing slash. */
export function clerkIssuer(): string {
  return (process.env.CLERK_FRONTEND_API_URL || process.env.CLERK_ISSUER || "https://clerk.vedantb.com").replace(/\/+$/, "");
}

/** Verifies a Clerk session token from the Bee app (the relay and the /bee/jobs routes). */
export function sessionVerifier(): VerifyToken {
  const parties = (process.env.CLERK_AUTHORIZED_PARTIES || "")
    .split(",")
    .map((party) => party.trim())
    .filter(Boolean);
  return createJwksVerifier({
    issuer: clerkIssuer(),
    jwksUrl: process.env.CLERK_JWKS_URL,
    authorizedParties: parties,
  });
}
