import { createServer } from "node:http";
import { z } from "zod";
import { SIGN_IN_PAGE_CSP, signInOutcome, signInPage } from "./clerk-oauth-page";

// Social sign-in returns the system browser here, not to bee://renderer/. A browser cannot show a custom-scheme URL as a
// page, so with bee:// the tab stayed on the provider's last page. Over HTTP on 127.0.0.1 it lands on Bee's own page.
// No Electron here: clerk-oauth-ipc.ts wires it in. Listens only while a sign-in waits, on a fixed port because the exact
// URL must be allowlisted in the Clerk Dashboard (Native applications → Allowlist for mobile SSO redirect).

export const CLERK_OAUTH_PORT = 45789;
export const CLERK_OAUTH_PATH = "/sso-callback";
export const CLERK_OAUTH_REDIRECT_URL = `http://127.0.0.1:${CLERK_OAUTH_PORT}${CLERK_OAUTH_PATH}`;
/** How long a sign-in waits for the browser, as in @clerk/electron. */
export const CLERK_OAUTH_TIMEOUT_MS = 180_000;

const providerUrlSchema = z.url({ protocol: /^https$/ });

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": SIGN_IN_PAGE_CSP,
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export type ClerkOAuthLoopback = {
  readonly redirectUrl: string;
  /**
   * The @clerk/electron transport contract: open the provider's https page in the browser and resolve with the URL the
   * browser came back to. A cancel or error resolves too; the client reads the outcome from the URL and shows it.
   */
  open(url: unknown): Promise<{ callbackUrl: string }>;
  /** Ends the waiting sign-in, if any, and stops listening. */
  cancel(): void;
};

export function createClerkOAuthLoopback(options: { openExternal: (url: string) => Promise<void>; port?: number; timeoutMs?: number }): ClerkOAuthLoopback {
  const port = options.port ?? CLERK_OAUTH_PORT;
  const timeoutMs = options.timeoutMs ?? CLERK_OAUTH_TIMEOUT_MS;
  const origin = `http://127.0.0.1:${port}`;
  // At most one sign-in waits at a time; it is cleared on every ending, so the next sign-in starts clean.
  let waiting: { fail(error: Error): void } | null = null;

  function open(url: unknown): Promise<{ callbackUrl: string }> {
    if (waiting) return Promise.reject(new Error("Sign-in is already in progress in your browser."));
    const providerUrl = providerUrlSchema.safeParse(url);
    if (!providerUrl.success) return Promise.reject(new Error("Sign-in can only open an https link."));

    return new Promise((resolve, reject) => {
      const flow = {
        succeed(callbackUrl: string): void {
          if (waiting !== flow) return;
          waiting = null;
          clearTimeout(timer);
          resolve({ callbackUrl });
        },
        fail(error: Error): void {
          if (waiting !== flow) return;
          waiting = null;
          clearTimeout(timer);
          server.close();
          reject(error);
        },
      };
      waiting = flow;
      const timer = setTimeout(() => flow.fail(new Error("Sign-in timed out. Try again.")), timeoutMs);

      const server = createServer((req, res) => {
        let url: URL;
        try {
          url = new URL(req.url ?? "/", origin);
        } catch {
          url = new URL("/", origin);
        }
        if (req.method !== "GET" || url.pathname !== CLERK_OAUTH_PATH) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
          return;
        }
        // Clerk returns its result in the query; a fragment never reaches a server, and the client does not read one.
        const callbackUrl = `${origin}${url.pathname}${url.search}`;
        // Stop listening once the page is out. Closing earlier would cut the response short.
        res.once("close", () => server.close());
        res.writeHead(200, PAGE_HEADERS).end(signInPage(signInOutcome(callbackUrl)));
        flow.succeed(callbackUrl);
      });
      server.on("error", (error: NodeJS.ErrnoException) => {
        flow.fail(error.code === "EADDRINUSE" ? new Error(`Bee could not start sign-in: port ${port} is in use.`, { cause: error }) : error);
      });
      server.listen(port, "127.0.0.1", () => {
        // Cancelled while the port was opening.
        if (waiting !== flow) {
          server.close();
          return;
        }
        Promise.resolve()
          .then(() => options.openExternal(providerUrl.data))
          .catch((error: unknown) => flow.fail(error instanceof Error ? error : new Error(String(error))));
      });
    });
  }

  return {
    redirectUrl: `${origin}${CLERK_OAUTH_PATH}`,
    open,
    cancel: () => waiting?.fail(new Error("Sign-in was cancelled.")),
  };
}
