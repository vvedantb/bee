import { startLoopback as start, type Loopback } from "@vvedantb/mcp-client";

// The redirect target for MCP sign-in: a one-shot HTTP server on 127.0.0.1 with a random port, from @vvedantb/mcp-client.
// Not bee://, which Clerk and Teams invites use.

export { LOOPBACK_PATH, LOOPBACK_TIMEOUT_MS, type Loopback } from "@vvedantb/mcp-client";

/** Starts listening on 127.0.0.1 with a free port. Call close when the sign-in ends. */
export function startLoopback(): Promise<Loopback> {
  return start({
    title: "Bee",
    messages: {
      invalid: "This sign-in link is not valid. Go back to Bee and try again.",
      incomplete: "Sign-in was not completed. You can close this window.",
      success: "You can close this window and go back to Bee.",
    },
  });
}
