import { createHash } from "node:crypto";
import { RENDERER_URL } from "../shared/clerk";
// Inlined as data URLs at build time, so the page needs no network and the server serves one response.
import logoOnDark from "../../resources/bee-logo.svg?inline";
import logoOnLight from "../../resources/bee-logo-light.svg?inline";
import instrumentSans from "../renderer/src/fonts/instrument-sans-latin.woff2?inline";

// The page the system browser lands on when social sign-in ends (clerk-oauth-loopback.ts). No text here may name the
// identity provider, the auth vendor or any AI model: users only ever see Bee.

export type SignInOutcome = "success" | "continue" | "cancelled" | "error";

// Sign-in and sign-up hand over to each other on these codes; Bee finishes the account in the app.
const TRANSFER_CODES = new Set(["external_account_not_found", "external_account_exists"]);

/** How sign-in ended, read from the query of the URL the browser was sent back to. */
export function signInOutcome(callbackUrl: string): SignInOutcome {
  let params: URLSearchParams;
  try {
    params = new URL(callbackUrl).searchParams;
  } catch {
    return "error";
  }
  if (params.get("__clerk_status") === "failed") {
    const code = params.get("__clerk_error_code") ?? "";
    if (code === "oauth_access_denied") return "cancelled";
    return TRANSFER_CODES.has(code) ? "continue" : "error";
  }
  const error = params.get("error");
  if (error) return error === "access_denied" ? "cancelled" : "error";
  return "success";
}

const COPY: Record<SignInOutcome, { title: string; heading: string; detail: string }> = {
  success: { title: "Signed in to Bee", heading: "Signed in to Bee", detail: "You can go back to Bee now." },
  continue: { title: "Finish signing in to Bee", heading: "Almost done", detail: "Go back to Bee to finish signing in." },
  cancelled: { title: "Sign-in cancelled · Bee", heading: "Sign-in was cancelled", detail: "Go back to Bee to try again." },
  error: { title: "Sign-in did not finish · Bee", heading: "Sign-in did not finish", detail: "Something went wrong. Go back to Bee to try again." },
};

// Drops the one-time sign-in values from the address bar and history. Browsers only let a script close a tab it
// opened, so the close after Return to Bee is best effort; closing on load would hide the message where it works.
const SCRIPT =
  'history.replaceState(null,"",location.pathname);' +
  'document.getElementById("return").addEventListener("click",function(){setTimeout(function(){window.close()},500)});';

/** Sent as a header with every page: inline styles, the hashed script and data: images and font only. */
export const SIGN_IN_PAGE_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  `script-src 'sha256-${createHash("sha256").update(SCRIPT).digest("base64")}'`,
  "img-src data:",
  "font-src data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const STYLE = `
@font-face {
  font-family: "Instrument Sans";
  font-style: normal;
  font-weight: 400 700;
  font-display: swap;
  src: url("${instrumentSans}") format("woff2");
}
:root {
  color-scheme: light dark;
  --page: #f6f1e7;
  --card: #fffdf8;
  --text: #17140f;
  --muted: #6b6253;
  --border: #e6ddcc;
  --accent: #fabe28;
  --on-accent: #17140f;
  --ring: #17140f;
}
@media (prefers-color-scheme: dark) {
  :root {
    --page: #110f0b;
    --card: #17140f;
    --text: #f4efe6;
    --muted: #a39a8a;
    --border: #2d271e;
    --ring: #fabe28;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body {
  display: grid;
  place-items: center;
  min-height: 100vh;
  padding: 24px;
  background: var(--page);
  color: var(--text);
  font: 400 16px/1.5 "Instrument Sans", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
}
main {
  width: 100%;
  max-width: 400px;
  padding: 36px 32px 28px;
  border: 1px solid var(--border);
  border-radius: 28px;
  background: var(--card);
  text-align: center;
}
.brand { display: inline-flex; align-items: center; gap: 8px; font-size: 17px; font-weight: 600; }
.brand img { width: 40px; height: 40px; }
.on-dark { display: none; }
@media (prefers-color-scheme: dark) {
  .on-light { display: none; }
  .on-dark { display: inline; }
}
h1 { margin: 22px 0 6px; font-size: 26px; font-weight: 600; line-height: 1.2; letter-spacing: -0.01em; text-wrap: balance; }
p { margin: 0; color: var(--muted); text-wrap: pretty; }
.return {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  margin-top: 26px;
  padding: 0 26px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
  text-decoration: none;
  transition: filter 150ms ease-out;
}
.return:hover { filter: brightness(1.06); }
.return:focus-visible { outline: 2px solid var(--ring); outline-offset: 3px; }
.hint { margin-top: 14px; font-size: 13px; }
`;

function attribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

/** The whole completion page. It reflects nothing from the request, so there is nothing to escape but our own assets. */
export function signInPage(outcome: SignInOutcome): string {
  const copy = COPY[outcome];
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>${copy.title}</title>
<link rel="icon" href="${attribute(logoOnLight)}">
<style>${STYLE}</style>
</head>
<body>
<main>
<div class="brand"><img class="on-light" src="${attribute(logoOnLight)}" alt="" width="40" height="40"><img class="on-dark" src="${attribute(logoOnDark)}" alt="" width="40" height="40">Bee</div>
<h1>${copy.heading}</h1>
<p>${copy.detail}</p>
<a class="return" id="return" href="${RENDERER_URL}">Return to Bee</a>
<p class="hint">You can close this tab.</p>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
