import { createServer } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { freePort, refused, send } from "../../test/helpers/loopback-http";
import { CLERK_OAUTH_PATH, CLERK_OAUTH_PORT, CLERK_OAUTH_REDIRECT_URL, CLERK_OAUTH_TIMEOUT_MS, createClerkOAuthLoopback } from "./clerk-oauth-loopback";
import { SIGN_IN_PAGE_CSP } from "./clerk-oauth-page";

const PROVIDER = "https://accounts.example.com/o/oauth2/auth?client_id=bee&state=s1";

/** A loopback on a free port whose browser is a spy: `opened` resolves with the URL it was asked to open. */
async function setup(options: { openExternal?: (url: string) => Promise<void> } = {}) {
  const port = await freePort();
  const openExternal = vi.fn<(url: string) => Promise<void>>(options.openExternal ?? (async () => undefined));
  const loopback = createClerkOAuthLoopback({ port, openExternal });
  const opened = () =>
    vi.waitFor(() => {
      const url = openExternal.mock.calls[0]?.[0];
      if (url === undefined) throw new Error("The browser was not opened yet");
      return url;
    });
  return { port, loopback, openExternal, opened, redirectUrl: loopback.redirectUrl };
}

describe("Clerk sign-in loopback", () => {
  it("advertises http://127.0.0.1:45789/sso-callback and waits three minutes", () => {
    expect(CLERK_OAUTH_REDIRECT_URL).toBe("http://127.0.0.1:45789/sso-callback");
    expect([CLERK_OAUTH_PORT, CLERK_OAUTH_PATH, CLERK_OAUTH_TIMEOUT_MS]).toEqual([45789, "/sso-callback", 180_000]);
    expect(createClerkOAuthLoopback({ openExternal: async () => undefined }).redirectUrl).toBe(CLERK_OAUTH_REDIRECT_URL);
  });

  it("listens only while a sign-in waits, opens the browser once listening and resolves with the full callback URL", async () => {
    const { loopback, openExternal, opened, redirectUrl } = await setup();
    expect(redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/sso-callback$/);
    expect(await refused(redirectUrl)).toBe(true);

    const result = loopback.open(PROVIDER);
    expect(await opened()).toBe(PROVIDER);
    const page = await send(`${redirectUrl}?rotating_token_nonce=abc`);

    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["content-security-policy"]).toBe(SIGN_IN_PAGE_CSP);
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect(page.body).toContain("<h1>Signed in to Bee</h1>");
    expect(page.body).toContain('href="bee://renderer/"');
    await expect(result).resolves.toEqual({ callbackUrl: `${redirectUrl}?rotating_token_nonce=abc` });
    expect(openExternal).toHaveBeenCalledTimes(1);
    await vi.waitFor(async () => expect(await refused(redirectUrl)).toBe(true));
  });

  it.each([
    ["cancelled", "?__clerk_status=failed&__clerk_error_code=oauth_access_denied", "Sign-in was cancelled"],
    ["failed", "?__clerk_status=failed&__clerk_error_code=oauth_callback_failed", "Sign-in did not finish"],
    ["plain OAuth error", "?error=server_error&error_description=x", "Sign-in did not finish"],
  ])("shows a friendly page and still hands over the URL when sign-in is %s", async (_name, query, heading) => {
    const { loopback, opened, redirectUrl } = await setup();
    const result = loopback.open(PROVIDER);
    await opened();
    const page = await send(redirectUrl + query);
    expect([page.status, page.headers["content-type"]]).toEqual([200, "text/html; charset=utf-8"]);
    expect(page.body).toContain(`<h1>${heading}</h1>`);
    expect(page.body).toContain(">Return to Bee</a>");
    await expect(result).resolves.toEqual({ callbackUrl: redirectUrl + query });
  });

  it("answers other paths and methods with 404 and keeps waiting", async () => {
    const { loopback, opened, port, redirectUrl } = await setup();
    const result = loopback.open(PROVIDER);
    await opened();
    for (const path of ["/", "/favicon.ico", "/sso-callback/", "/sso-callback/extra", "/callback"]) {
      const response = await send(`http://127.0.0.1:${port}${path}?rotating_token_nonce=abc`);
      expect([path, response.status, response.body]).toEqual([path, 404, "Not found"]);
    }
    expect((await send(`${redirectUrl}?rotating_token_nonce=abc`, "POST")).status).toBe(404);
    await expect(loopback.open(PROVIDER)).rejects.toThrow("already in progress");

    await send(`${redirectUrl}?rotating_token_nonce=ok`);
    await expect(result).resolves.toEqual({ callbackUrl: `${redirectUrl}?rotating_token_nonce=ok` });
  });

  it("runs one sign-in at a time and starts clean for the next one (sign out, sign in again)", async () => {
    const { loopback, openExternal, redirectUrl } = await setup();
    for (const nonce of ["first", "second"]) {
      openExternal.mockClear();
      const result = loopback.open(PROVIDER);
      await expect(loopback.open(PROVIDER)).rejects.toThrow("Sign-in is already in progress in your browser.");
      await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1));
      await send(`${redirectUrl}?rotating_token_nonce=${nonce}`);
      await expect(result).resolves.toEqual({ callbackUrl: `${redirectUrl}?rotating_token_nonce=${nonce}` });
      await vi.waitFor(async () => expect(await refused(redirectUrl)).toBe(true));
    }
  });

  it("opens only https provider pages", async () => {
    const { loopback, openExternal, redirectUrl } = await setup();
    for (const url of ["http://accounts.example.com/", "javascript:alert(1)", "bee://renderer/", "file:///etc/passwd", "not a url", "", 42, undefined]) {
      await expect(loopback.open(url)).rejects.toThrow("Sign-in can only open an https link.");
    }
    expect(openExternal).not.toHaveBeenCalled();
    expect(await refused(redirectUrl)).toBe(true);
  });

  it("times out after three minutes, stops listening and lets the next sign-in start", async () => {
    const { loopback, openExternal, redirectUrl } = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const first = loopback.open(PROVIDER);
      const timedOut = expect(first).rejects.toThrow("Sign-in timed out. Try again.");
      let settled = false;
      first.then(
        () => void (settled = true),
        () => void (settled = true),
      );
      await vi.advanceTimersByTimeAsync(CLERK_OAUTH_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await timedOut;
      await vi.waitFor(async () => expect(await refused(redirectUrl)).toBe(true));

      openExternal.mockClear();
      const next = loopback.open(PROVIDER);
      await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1));
      await send(`${redirectUrl}?rotating_token_nonce=abc`);
      await expect(next).resolves.toEqual({ callbackUrl: `${redirectUrl}?rotating_token_nonce=abc` });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects and stops listening when the browser cannot be opened", async () => {
    const { loopback, redirectUrl } = await setup({ openExternal: async () => Promise.reject(new Error("no browser")) });
    await expect(loopback.open(PROVIDER)).rejects.toThrow("no browser");
    await vi.waitFor(async () => expect(await refused(redirectUrl)).toBe(true));
    await expect(loopback.open(PROVIDER)).rejects.toThrow("no browser");
  });

  it("says so when the port is taken, without opening the browser", async () => {
    const { loopback, openExternal, port } = await setup();
    const squatter = createServer();
    await new Promise<void>((resolve) => squatter.listen(port, "127.0.0.1", resolve));
    try {
      await expect(loopback.open(PROVIDER)).rejects.toThrow(`Bee could not start sign-in: port ${port} is in use.`);
      expect(openExternal).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
    // Nothing is left pending: the next sign-in opens the browser.
    const next = loopback.open(PROVIDER);
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1));
    loopback.cancel();
    await expect(next).rejects.toThrow("Sign-in was cancelled.");
  });

  it("cancel ends a waiting sign-in and stops listening; with nothing waiting it does nothing", async () => {
    const { loopback, opened, redirectUrl } = await setup();
    loopback.cancel();
    const result = loopback.open(PROVIDER);
    await opened();
    loopback.cancel();
    await expect(result).rejects.toThrow("Sign-in was cancelled.");
    await vi.waitFor(async () => expect(await refused(redirectUrl)).toBe(true));
  });

  it("does not stay listening when cancelled before the port opened", async () => {
    const { loopback, openExternal, redirectUrl } = await setup();
    const result = loopback.open(PROVIDER);
    loopback.cancel();
    await expect(result).rejects.toThrow("Sign-in was cancelled.");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await refused(redirectUrl)).toBe(true);
    expect(openExternal).not.toHaveBeenCalled();
  });
});
