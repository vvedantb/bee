import { z } from "zod";
import { CLERK_PUBLISHABLE_KEY, frontendApiHost } from "../shared/clerk";

const claimsSchema = z.object({ iss: z.string(), sub: z.string().min(1), exp: z.number() });

export const CLERK_ISSUER = `https://${frontendApiHost(CLERK_PUBLISHABLE_KEY)}`;

/**
 * Sign-in gate for the pipeline: the renderer must send a live Clerk session token from Bee's instance.
 * The signature is not verified. This keeps signed-out calls out; it is not a security boundary,
 * since the renderer is Bee's own code and the pipeline only uses the user's own key and notes.
 */
export function assertSignedIn(sessionToken: string, nowMs = Date.now()): void {
  const claims = readClaims(sessionToken);
  if (!claims || claims.iss !== CLERK_ISSUER || claims.exp * 1000 <= nowMs) {
    throw new Error("Sign in to Bee to get guidance.");
  }
}

function readClaims(token: string): z.infer<typeof claimsSchema> | null {
  try {
    const payload = Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8");
    return claimsSchema.parse(JSON.parse(payload));
  } catch {
    return null;
  }
}
