import { createJwksVerifier } from "./jwt";
import { startMemoryRelay } from "./memory";

// Local relay for development: npm run relay:mock, then BEE_RELAY_URL=http://127.0.0.1:8787 npm run dev.
// Verifies real Clerk tokens against the instance JWKS. State is lost on exit.

const issuer = process.env.CLERK_ISSUER || "https://clerk.vedantb.com";
const verify = createJwksVerifier({ issuer, jwksUrl: process.env.CLERK_JWKS_URL });
const { url } = await startMemoryRelay({ verify, port: Number(process.env.PORT || 8787) });
console.log(`Bee relay (in memory) on ${url}, issuer ${issuer}`);
