import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RENDERER_URL } from "../shared/clerk";
import { SIGN_IN_PAGE_CSP, signInOutcome, signInPage, type SignInOutcome } from "./clerk-oauth-page";

const CALLBACK = "http://127.0.0.1:45789/sso-callback";
const OUTCOMES: SignInOutcome[] = ["success", "continue", "cancelled", "error"];

// The page without the inlined logo and font (base64 or percent-encoded, always inside double quotes).
const withoutData = (html: string): string => html.replace(/data:[^"\s]+/g, "data:");
// What a reader sees: no style, script or tags.
const visibleText = (html: string): string =>
  html
    .replace(/<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

describe("signInOutcome", () => {
  it.each([
    ["?rotating_token_nonce=abc", "success"],
    ["", "success"],
    ["?__clerk_status=verified&rotating_token_nonce=abc", "success"],
    ["?__clerk_status=failed&__clerk_error_code=oauth_access_denied", "cancelled"],
    ["?error=access_denied", "cancelled"],
    ["?__clerk_status=failed&__clerk_error_code=external_account_not_found", "continue"],
    ["?__clerk_status=failed&__clerk_error_code=external_account_exists", "continue"],
    ["?__clerk_status=failed&__clerk_error_code=oauth_callback_failed", "error"],
    ["?__clerk_status=failed", "error"],
    ["?error=server_error", "error"],
  ] as const)("reads %j as %s", (query, outcome) => {
    expect(signInOutcome(CALLBACK + query)).toBe(outcome);
  });

  it("treats an unreadable URL as an error", () => {
    expect(signInOutcome("not a url")).toBe("error");
  });
});

describe("signInPage", () => {
  it.each([
    ["success", "Signed in to Bee", "Bee Signed in to Bee You can go back to Bee now. Return to Bee You can close this tab."],
    ["continue", "Finish signing in to Bee", "Bee Almost done Go back to Bee to finish signing in. Return to Bee You can close this tab."],
    ["cancelled", "Sign-in cancelled · Bee", "Bee Sign-in was cancelled Go back to Bee to try again. Return to Bee You can close this tab."],
    ["error", "Sign-in did not finish · Bee", "Bee Sign-in did not finish Something went wrong. Go back to Bee to try again. Return to Bee You can close this tab."],
  ] as const)("shows the %s copy", (outcome, title, text) => {
    const html = signInPage(outcome);
    expect(html).toContain(`<title>${title}</title>`);
    expect(visibleText(html)).toBe(`${title} ${text}`);
  });

  it.each(OUTCOMES)("links %s back to Bee's renderer and tries to close the tab", (outcome) => {
    const html = signInPage(outcome);
    expect(RENDERER_URL).toBe("bee://renderer/");
    expect(html.match(/<a [^>]*>Return to Bee<\/a>/g)).toEqual(['<a class="return" id="return" href="bee://renderer/">Return to Bee</a>']);
    expect(html).toContain("window.close()");
    expect(html).toContain('history.replaceState(null,"",location.pathname)');
  });

  it.each(OUTCOMES)("never names the provider, the auth vendor or an AI model (%s)", (outcome) => {
    expect(withoutData(signInPage(outcome))).not.toMatch(/clerk|google|oauth|anthropic|claude|openai|gpt|gemini|grok|llama|mistral/i);
  });

  it("is self-contained: Bee's font and logo are inlined and nothing loads from the network", () => {
    const html = signInPage("success");
    expect(html).toContain('src: url("data:font/woff2;base64,');
    expect(html).toContain("font-family: \"Instrument Sans\"");
    expect(html).toMatch(/<img class="on-light" src="data:image\/svg\+xml,/);
    expect(html).toMatch(/<img class="on-dark" src="data:image\/svg\+xml,/);
    // A data: icon, so the browser never asks the (already closed) server for /favicon.ico.
    expect(html).toMatch(/<link rel="icon" href="data:image\/svg\+xml,/);
    expect(withoutData(html)).not.toMatch(/https?:\/\//);
  });

  it("uses Bee's accent and follows the system light or dark theme", () => {
    const html = signInPage("success");
    expect(html).toContain('<html lang="en-GB">');
    expect(html).toContain("--accent: #fabe28;");
    expect(html).toContain("--on-accent: #17140f;");
    expect(html).toContain("@media (prefers-color-scheme: dark)");
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
  });
});

describe("SIGN_IN_PAGE_CSP", () => {
  it("allows exactly the page's inline script and data: assets, and nothing remote", () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(signInPage("success"))?.[1] ?? "";
    const hash = createHash("sha256").update(script).digest("base64");
    expect(SIGN_IN_PAGE_CSP).toBe(
      `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${hash}'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
  });
});
