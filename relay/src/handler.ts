import { z } from "zod";
import {
  createRoomRequestSchema,
  createTeamRequestSchema,
  inviteRequestSchema,
  joinRoomRequestSchema,
  joinTeamRequestSchema,
  mergeRequestSchema,
  presenceRequestSchema,
  profileRequestSchema,
  publishRequestSchema,
} from "../../src/core/relay-protocol";
import { AuthError, type Identity, type VerifyToken } from "./jwt";
import { HttpError, createRelayState, type RelayStorage } from "./state";

// HTTP routes of the relay. Shared by the Durable Object (index.ts) and the in-memory mock (memory.ts).
// Every route needs a valid Clerk session token; speaker identity comes from it, never from the body.

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
};

function json(status: number, body: object): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } });
}

export function createRelayHandler(args: { storage: RelayStorage; verify: VerifyToken; now?: () => number }) {
  const now = args.now ?? Date.now;
  const state = createRelayState(args.storage, now);
  let queue: Promise<void> = Promise.resolve();

  async function route(request: Request, identity: Identity): Promise<object> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname.replace(/\/+$/, "");
    const body = async <T extends z.ZodType>(schema: T): Promise<z.infer<T>> => schema.parse(await request.json());
    const roomMatch = /^\/v1\/rooms\/([^/]+)\/(leave|invite|merge|phrases)$/.exec(path);

    if (path === "/v1/me" && method === "GET") return state.me(identity);
    if (path === "/v1/me" && method === "PUT") return state.setProfile(identity, (await body(profileRequestSchema)).displayName);
    if (path === "/v1/teams" && method === "POST") {
      const input = await body(createTeamRequestSchema);
      return { team: await state.createTeam(identity, input.name, input.displayName) };
    }
    if (path === "/v1/teams/join" && method === "POST") {
      const input = await body(joinTeamRequestSchema);
      return { team: await state.joinTeam(identity, input.code, input.displayName) };
    }
    if (path === "/v1/team/leave" && method === "POST") {
      await state.leaveTeam(identity);
      return { ok: true };
    }
    if (path === "/v1/presence" && method === "PUT") {
      return { presence: await state.setPresence(identity, (await body(presenceRequestSchema)).inMeeting) };
    }
    if (path === "/v1/presence" && method === "GET") return { presence: await state.listPresence(identity) };
    if (path === "/v1/rooms" && method === "GET") return state.listRooms(identity);
    if (path === "/v1/rooms" && method === "POST") return state.createRoom(identity, (await body(createRoomRequestSchema)).invite);
    if (path === "/v1/rooms/join" && method === "POST") return state.joinRoom(identity, await body(joinRoomRequestSchema));
    if (roomMatch) {
      const roomId = decodeURIComponent(roomMatch[1] ?? "");
      const action = roomMatch[2];
      if (action === "leave" && method === "POST") {
        await state.leaveRoom(identity, roomId);
        return { ok: true };
      }
      if (action === "invite" && method === "POST") return state.invite(identity, roomId, (await body(inviteRequestSchema)).userIds);
      if (action === "merge" && method === "POST") {
        return state.requestMerge(identity, roomId, (await body(mergeRequestSchema)).targetRoomId);
      }
      if (action === "phrases" && method === "POST") {
        const input = await body(publishRequestSchema);
        return { phrase: await state.publish(identity, roomId, input.text, input.spokenAt) };
      }
      if (action === "phrases" && method === "GET") {
        const after = z.coerce.number().int().min(0).catch(0).parse(url.searchParams.get("after") ?? 0);
        return state.phrases(identity, roomId, after);
      }
    }
    throw new HttpError(404, "Not found");
  }

  // One request at a time, so read-modify-write on storage never interleaves.
  function serialised<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (new URL(request.url).pathname === "/health") return json(200, { ok: true, serverNow: now() });
    const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!token) return json(401, { error: "Sign in to Bee to sync" });
    let identity: Identity;
    try {
      identity = await args.verify(token);
    } catch (error) {
      return json(401, { error: error instanceof AuthError ? error.message : "Could not verify sign-in" });
    }
    try {
      const body = await serialised(() => route(request, identity));
      return json(200, { serverNow: now(), ...body });
    } catch (error) {
      if (error instanceof HttpError) return json(error.status, { error: error.message });
      if (error instanceof z.ZodError || error instanceof SyntaxError) return json(400, { error: "Bad request" });
      return json(500, { error: "Relay error" });
    }
  };
}
