import { createServer, type Server } from "node:http";
import { createRelayHandler } from "./handler";
import type { VerifyToken } from "./jwt";
import type { RelayStorage } from "./state";

// In-memory relay for tests and local development: the same handler as the Worker, over a Map.

export function memoryStorage(): RelayStorage {
  const map = new Map<string, string>();
  return {
    get: async (key) => map.get(key),
    put: async (key, value) => {
      map.set(key, value);
    },
    delete: async (key) => {
      map.delete(key);
    },
  };
}

/** A fetch function that calls the relay directly, for unit tests without a server. */
export function memoryRelayFetch(args: { verify: VerifyToken; now?: () => number }): typeof globalThis.fetch {
  const handle = createRelayHandler({ storage: memoryStorage(), verify: args.verify, now: args.now });
  return (input, init) => handle(new Request(input, init));
}

/** Serves the in-memory relay over HTTP on 127.0.0.1. Resolves with its base URL. */
export async function startMemoryRelay(args: { verify: VerifyToken; port?: number }): Promise<{ url: string; server: Server }> {
  const handle = createRelayHandler({ storage: memoryStorage(), verify: args.verify });
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
      const request = new Request(`http://127.0.0.1${req.url ?? "/"}`, { method: req.method, headers, body });
      void handle(request).then(async (response) => {
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(args.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, server };
}
