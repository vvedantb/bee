import { z } from "zod";
import {
  errorResponseSchema,
  meResponseSchema,
  okResponseSchema,
  phrasesResponseSchema,
  presenceResponseSchema,
  publishResponseSchema,
  roomResponseSchema,
  roomsResponseSchema,
  teamResponseSchema,
} from "./relay-protocol";
import { clockSample, type ClockSample } from "./sync-lines";

// HTTP client for the Bee relay. Each call sends the caller's Clerk session token; the relay verifies it.

const RELAY_TIMEOUT_MS = 8000;

export class RelayError extends Error {
  // 0 when the relay could not be reached.
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export type RelayClient = ReturnType<typeof createRelayClient>;

export function createRelayClient(args: {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  onClock?: (sample: ClockSample) => void;
}) {
  const base = args.baseUrl.replace(/\/+$/, "");
  const fetchImpl = args.fetch ?? globalThis.fetch;
  const now = args.now ?? Date.now;

  async function call<T extends z.ZodType<{ serverNow: number }>>(
    schema: T,
    token: string,
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: object,
  ): Promise<z.infer<T>> {
    const sentAt = now();
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      });
    } catch (error) {
      throw new RelayError(`Relay unreachable: ${error instanceof Error ? error.message : String(error)}`, 0);
    }
    const receivedAt = now();
    const text = await response.text();
    let json: object | null = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (!response.ok) {
      const parsed = errorResponseSchema.safeParse(json);
      throw new RelayError(parsed.success ? parsed.data.error : `Relay error ${response.status}`, response.status);
    }
    const data = schema.parse(json);
    args.onClock?.(clockSample(sentAt, receivedAt, data.serverNow));
    return data;
  }

  const room = (roomId: string) => `/v1/rooms/${encodeURIComponent(roomId)}`;

  return {
    me: (token: string) => call(meResponseSchema, token, "GET", "/v1/me"),
    setProfile: (token: string, displayName: string) => call(meResponseSchema, token, "PUT", "/v1/me", { displayName }),
    createTeam: (token: string, name: string, displayName: string) =>
      call(teamResponseSchema, token, "POST", "/v1/teams", { name, displayName }),
    joinTeam: (token: string, code: string, displayName: string) =>
      call(teamResponseSchema, token, "POST", "/v1/teams/join", { code, displayName }),
    leaveTeam: (token: string) => call(okResponseSchema, token, "POST", "/v1/team/leave", {}),
    setPresence: (token: string, inMeeting: boolean) => call(presenceResponseSchema, token, "PUT", "/v1/presence", { inMeeting }),
    listPresence: (token: string) => call(presenceResponseSchema, token, "GET", "/v1/presence"),
    listRooms: (token: string) => call(roomsResponseSchema, token, "GET", "/v1/rooms"),
    createRoom: (token: string, invite: string[]) => call(roomResponseSchema, token, "POST", "/v1/rooms", { invite }),
    joinRoom: (token: string, target: { roomId: string } | { code: string }) =>
      call(roomResponseSchema, token, "POST", "/v1/rooms/join", target),
    leaveRoom: (token: string, roomId: string) => call(okResponseSchema, token, "POST", `${room(roomId)}/leave`, {}),
    invite: (token: string, roomId: string, userIds: string[]) =>
      call(roomResponseSchema, token, "POST", `${room(roomId)}/invite`, { userIds }),
    requestMerge: (token: string, roomId: string, targetRoomId: string) =>
      call(roomResponseSchema, token, "POST", `${room(roomId)}/merge`, { targetRoomId }),
    publish: (token: string, roomId: string, text: string, spokenAt: number) =>
      call(publishResponseSchema, token, "POST", `${room(roomId)}/phrases`, { text, spokenAt }),
    phrases: (token: string, roomId: string, after: number) =>
      call(phrasesResponseSchema, token, "GET", `${room(roomId)}/phrases?after=${after}`),
  };
}
