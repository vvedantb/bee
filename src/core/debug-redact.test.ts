import { describe, expect, it } from "vitest";
import { MAX_STRING_CHARS, REDACTED, isSecretKey, redactDebugData, redactString } from "./debug-redact";

// Fake values shaped like real ones, none of them a real secret. Built at run time so no key-shaped text is committed for a
// secret scanner to flag.
const JWT = ["eyJhbGciOiJSUzI1NiJ9", "eyJzdWIiOiJ1c2VyXzEyMyIsImV4cCI6MTc5MDAwMDAwMH0", "c2lnbmF0dXJlLXBhcnQtaGVyZQ"].join(".");
const GATEWAY = ["vck", "FAKE1234567890abcdefGHIJ"].join("_");
const OPENAI = ["sk", "proj", "abcdefghijklmnop1234"].join("-");
const CLERK = ["sk", "live", "abcdefghijklmnop1234"].join("_");

describe("isSecretKey", () => {
  it("matches secret names in any case and spelling", () => {
    for (const key of ["token", "sessionToken", "apiKey", "apikey", "API_KEY", "x-api-key", "Authorization", "password", "clientSecret", "mcpSecrets", "refresh_token", "access_token", "gatewayApiKey", "cipher", "Cookie", "set-cookie"]) {
      expect(isSecretKey(key), key).toBe(true);
    }
  });

  it("leaves ordinary names alone", () => {
    for (const key of ["text", "command", "transcript", "tips", "notesDir", "secretStorage", "gatewayKeySource", "level", "hasAuth"]) {
      expect(isSecretKey(key), key).toBe(false);
    }
  });
});

describe("redactDebugData", () => {
  it("replaces the text of secret fields at any depth", () => {
    const out = redactDebugData({
      sessionToken: JWT,
      settings: { gatewayApiKey: "c2VjcmV0LWNpcGhlcg==", nested: { refresh_token: "r-123", access_token: "a-456" } },
      headers: { "X-Custom": "anything" },
      env: { MODE: "x", API_KEY: "env-FAKE" },
      mcpSecrets: "cipher-text",
    });
    expect(out).toEqual({
      sessionToken: REDACTED,
      settings: { gatewayApiKey: REDACTED, nested: { refresh_token: REDACTED, access_token: REDACTED } },
      headers: { "X-Custom": REDACTED },
      env: { MODE: REDACTED, API_KEY: REDACTED },
      mcpSecrets: REDACTED,
    });
  });

  it("keeps token counts and sign-in flags", () => {
    const usage = { inputTokens: 120, outputTokens: 40, inputTokenDetails: { cacheReadTokens: 100, cacheWriteTokens: 0 }, outputTokenDetails: { reasoningTokens: 0 } };
    expect(redactDebugData({ usage, hasToken: true, signedIn: false })).toEqual({ usage, hasToken: true, signedIn: false });
  });

  it("finds keys inside ordinary text: prompts, errors and notes", () => {
    const out = redactDebugData({
      error: `401 for Bearer ${GATEWAY}`,
      note: `my key is ${GATEWAY} and token ${JWT}`,
      prompt: `OpenAI key ${OPENAI} and Clerk ${CLERK}`,
      link: "https://example.com/callback?code=abc123&state=xyz&page=2",
    }) as Record<string, string>;
    expect(out.error).toBe(`401 for Bearer ${REDACTED}`);
    expect(out.note).toBe("my key is [redacted-key] and token [redacted-jwt]");
    expect(out.prompt).toBe("OpenAI key [redacted-key] and Clerk [redacted-key]");
    expect(out.link).toBe(`https://example.com/callback?code=${REDACTED}&state=${REDACTED}&page=2`);
    for (const text of Object.values(out)) {
      expect(text).not.toContain(GATEWAY);
      expect(text).not.toContain(JWT);
    }
  });

  it("keeps meeting words, commands and replies as they are", () => {
    const data = { command: "open Discord and send Sam the notes", text: "Be careful with the Friday release, it needs a token of thanks.", tips: ["The District line is closed."] };
    expect(redactDebugData(data)).toEqual(data);
  });

  it("shortens images, audio and data URLs", () => {
    const image = "iVBORw0KGgo".repeat(500);
    const out = redactDebugData({ output: { text: "Screenshot", image }, audio: new Uint8Array(32_000), icon: "data:image/png;base64,AAAA" }) as Record<string, unknown>;
    expect(out.output).toEqual({ text: "Screenshot", image: `[base64 ${image.length} chars]` });
    expect(out.audio).toBe("[bytes 32000]");
    expect(out.icon).toBe("[data-url 26 chars]");
  });

  it("caps very long text", () => {
    const long = "word ".repeat(MAX_STRING_CHARS);
    const out = redactString(long);
    expect(out.length).toBeLessThan(MAX_STRING_CHARS + 40);
    expect(out).toMatch(/more chars\]$/);
  });

  it("turns errors, dates, cycles and odd values into plain data, and never returns the input", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    const input = { error: new Error(`failed with Bearer ${GATEWAY}`), when: new Date(0), cyclic, big: 10n, fn: () => 1, nan: Number.NaN };
    const out = redactDebugData(input) as Record<string, unknown>;
    expect(out.error).toMatchObject({ name: "Error", message: `failed with Bearer ${REDACTED}` });
    expect(out.when).toBe("1970-01-01T00:00:00.000Z");
    expect(out.cyclic).toEqual({ name: "loop", self: "[circular]" });
    expect(out.big).toBe("10");
    expect(out).not.toHaveProperty("fn");
    expect(out.nan).toBe("NaN");
    expect(out).not.toBe(input);
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("allows the same object twice when it is not a cycle", () => {
    const shared = { id: 1 };
    expect(redactDebugData({ a: shared, b: shared })).toEqual({ a: { id: 1 }, b: { id: 1 } });
  });
});
