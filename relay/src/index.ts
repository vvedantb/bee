import { createRelayHandler } from "./handler";
import { createJwksVerifier } from "./jwt";

// Cloudflare Worker entry. Every request goes to one Durable Object, which owns teams, presence, rooms and
// phrases for all teams. That keeps membership checks and room state strongly consistent. It is sized for
// small companies (a few hundred users); shard by team id (idFromName(teamId)) before growing past that.

// The parts of the Workers runtime types Bee uses, so the Worker typechecks without @cloudflare/workers-types.
type DurableObjectStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
};
type DurableObjectState = { storage: DurableObjectStorage };
type DurableObjectId = { toString(): string };
type DurableObjectNamespace = {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): { fetch(request: Request): Promise<Response> };
};

export type Env = {
  RELAY: DurableObjectNamespace;
  // Clerk instance issuer, e.g. https://clerk.vedantb.com.
  CLERK_ISSUER: string;
  // Optional: defaults to <issuer>/.well-known/jwks.json.
  CLERK_JWKS_URL?: string;
  // Optional, comma-separated: allowed azp claims (for example bee://renderer).
  CLERK_AUTHORIZED_PARTIES?: string;
};

export class BeeRelay {
  private readonly handle: (request: Request) => Promise<Response>;

  constructor(state: DurableObjectState, env: Env) {
    const storage = state.storage;
    this.handle = createRelayHandler({
      storage: {
        get: (key) => storage.get<string>(key),
        put: (key, value) => storage.put(key, value),
        delete: async (key) => {
          await storage.delete(key);
        },
      },
      verify: createJwksVerifier({
        issuer: env.CLERK_ISSUER,
        jwksUrl: env.CLERK_JWKS_URL,
        authorizedParties: (env.CLERK_AUTHORIZED_PARTIES ?? "")
          .split(",")
          .map((party) => party.trim())
          .filter(Boolean),
      }),
    });
  }

  fetch(request: Request): Promise<Response> {
    return this.handle(request);
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return env.RELAY.get(env.RELAY.idFromName("bee")).fetch(request);
  },
};
