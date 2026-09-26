import { describe, expect, it } from "vitest";
import { CLERK_ISSUER, assertSignedIn } from "./auth";

const NOW = 1_800_000_000_000;

function token(claims: Record<string, string | number>): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part(claims)}.signature`;
}

describe("assertSignedIn", () => {
  const live = { iss: CLERK_ISSUER, sub: "user_1", exp: NOW / 1000 + 60 };

  it("uses the vedantb.com Frontend API as issuer by default", () => {
    expect(CLERK_ISSUER).toBe("https://clerk.vedantb.com");
  });

  it("accepts a live token from Bee's instance", () => {
    expect(() => assertSignedIn(token(live), NOW)).not.toThrow();
  });

  it("rejects expired, foreign, empty and malformed tokens", () => {
    for (const bad of [
      token({ ...live, exp: NOW / 1000 - 1 }),
      token({ ...live, iss: "https://clerk.example.com" }),
      token({ iss: CLERK_ISSUER, exp: live.exp }),
      "",
      "not-a-jwt",
      "a.%%%.c",
    ]) {
      expect(() => assertSignedIn(bad, NOW)).toThrow("Sign in to Bee");
    }
  });
});
