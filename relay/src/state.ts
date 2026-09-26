import { z } from "zod";
import {
  INVITE_ALPHABET,
  TEXT_MAX,
  normaliseRoomCode,
  parseInviteCode,
  type Member,
  type Phrase,
  type Presence,
  type Room,
  type Team,
} from "../../src/core/relay-protocol";
import type { Identity } from "./jwt";

// Relay state over a small string key-value store: Durable Object storage in production, a Map in tests.
// Team membership persists. Presence, rooms and phrases are ephemeral: rooms close when empty or after
// ROOM_TTL_MS, and their phrases are deleted with them.

export type RelayStorage = {
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
};

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const ROOM_TTL_MS = 4 * 60 * 60_000;
// A member whose client has not polled for this long is dropped (crashed, offline, lid closed).
export const MEMBER_STALE_MS = 60_000;
// Merged rooms stay readable this long so their members can follow mergedInto.
const MERGED_KEEP_MS = 10 * 60_000;
// Phrases kept per room; joiners only read what is said after they join.
const PHRASES_MAX = 400;
// A sender's "spoken at" may be this far before the relay received it (speech-to-text latency).
const SPOKEN_AT_MAX_LAG_MS = 30_000;

const teamRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  inviteCode: z.string(),
  createdBy: z.string(),
  createdAt: z.number(),
  members: z.record(z.string(), z.object({ displayName: z.string(), joinedAt: z.number() })),
});
type TeamRecord = z.infer<typeof teamRecordSchema>;

const roomRecordSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  code: z.string(),
  createdAt: z.number(),
  createdBy: z.string(),
  members: z.record(z.string(), z.object({ joinedAt: z.number(), lastSeen: z.number() })),
  invited: z.array(z.string()),
  mergeWith: z.string().nullable(),
  mergedInto: z.string().nullable(),
  closedAt: z.number().nullable(),
  nextSeq: z.number().int(),
});
type RoomRecord = z.infer<typeof roomRecordSchema>;

const presenceRecordSchema = z.record(z.string(), z.object({ inMeetingSince: z.number().nullable(), updatedAt: z.number() }));
type PresenceRecord = z.infer<typeof presenceRecordSchema>;

const phraseRecordSchema = z.array(
  z.object({ seq: z.number(), speakerId: z.string(), text: z.string(), spokenAt: z.number(), serverTs: z.number() }),
);
const idListSchema = z.array(z.string());

const ADJECTIVES = [
  "amber", "brisk", "calm", "coral", "dusky", "eager", "fern", "gentle", "golden", "hazel", "ivory", "jolly",
  "keen", "lemon", "lively", "mellow", "misty", "noble", "olive", "plucky", "quiet", "rapid", "rosy", "sandy",
  "silver", "sunny", "tidy", "velvet", "warm", "witty", "young", "zesty",
];
const ANIMALS = [
  "otter", "badger", "bee", "crane", "dove", "eagle", "ferret", "gecko", "heron", "ibis", "jay", "koala", "lark",
  "lynx", "marten", "newt", "owl", "panda", "quail", "raven", "robin", "seal", "swift", "tapir", "toad", "vole",
  "walrus", "wren", "yak", "zebra", "finch", "hare",
];

function randomIndex(size: number): number {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return (values[0] ?? 0) % size;
}

function randomInviteCode(): string {
  return Array.from({ length: 8 }, () => INVITE_ALPHABET[randomIndex(INVITE_ALPHABET.length)]).join("");
}

function randomWords(): string {
  return `${ADJECTIVES[randomIndex(ADJECTIVES.length)]}-${ANIMALS[randomIndex(ANIMALS.length)]}`;
}

export function createRelayState(storage: RelayStorage, now: () => number = Date.now) {
  async function read<T extends z.ZodType>(schema: T, key: string): Promise<z.infer<T> | null> {
    const raw = await storage.get(key);
    return raw === undefined ? null : schema.parse(JSON.parse(raw));
  }
  const write = (key: string, value: object) => storage.put(key, JSON.stringify(value));

  const teamKey = (id: string) => `team:${id}`;
  const roomKey = (id: string) => `room:${id}`;
  const roomsKey = (teamId: string) => `rooms:${teamId}`;
  const roomCodeKey = (teamId: string, code: string) => `roomcode:${teamId}:${code}`;
  const presenceKey = (teamId: string) => `presence:${teamId}`;
  const phrasesKey = (roomId: string) => `phrases:${roomId}`;

  async function teamOf(userId: string): Promise<TeamRecord | null> {
    const teamId = await storage.get(`user:${userId}`);
    return teamId === undefined ? null : read(teamRecordSchema, teamKey(teamId));
  }

  /** The caller's team, with their name refreshed from the token when it carries one. */
  async function requireTeam(identity: Identity): Promise<TeamRecord> {
    const team = await teamOf(identity.userId);
    const member = team?.members[identity.userId];
    if (!team || !member) throw new HttpError(403, "Not on a team");
    if (identity.name && identity.name !== member.displayName) {
      team.members[identity.userId] = { ...member, displayName: identity.name };
      await write(teamKey(team.id), team);
    }
    return team;
  }

  function nameOf(team: TeamRecord, userId: string): string {
    return team.members[userId]?.displayName ?? "Former teammate";
  }

  function teamView(team: TeamRecord): Team {
    const members = Object.entries(team.members)
      .sort((a, b) => a[1].joinedAt - b[1].joinedAt)
      .map(([userId, member]) => ({ userId, displayName: member.displayName }));
    return { id: team.id, name: team.name, inviteCode: team.inviteCode, createdBy: team.createdBy, members };
  }

  function roomView(team: TeamRecord, room: RoomRecord): Room {
    const members: Member[] = Object.entries(room.members)
      .sort((a, b) => a[1].joinedAt - b[1].joinedAt)
      .map(([userId]) => ({ userId, displayName: nameOf(team, userId) }));
    return {
      id: room.id,
      code: room.code,
      createdAt: room.createdAt,
      createdBy: room.createdBy,
      members,
      invited: room.invited,
      mergeWith: room.mergeWith,
      mergedInto: room.mergedInto,
    };
  }

  async function closeRoom(room: RoomRecord): Promise<void> {
    room.closedAt = now();
    room.members = room.mergedInto ? room.members : {};
    await storage.delete(phrasesKey(room.id));
    await storage.delete(roomCodeKey(room.teamId, room.code));
    if (room.mergedInto) await write(roomKey(room.id), room);
    else await storage.delete(roomKey(room.id));
  }

  /** Every room of the team still listed, after dropping stale members and closing empty or expired rooms. */
  async function sweep(teamId: string): Promise<RoomRecord[]> {
    const ids = (await read(idListSchema, roomsKey(teamId))) ?? [];
    const kept: RoomRecord[] = [];
    const time = now();
    for (const id of ids) {
      const room = await read(roomRecordSchema, roomKey(id));
      if (!room) continue;
      if (room.closedAt !== null) {
        if (time - room.closedAt < MERGED_KEEP_MS) kept.push(room);
        else await storage.delete(roomKey(id));
        continue;
      }
      const before = Object.keys(room.members).length;
      for (const [userId, member] of Object.entries(room.members)) {
        if (time - member.lastSeen > MEMBER_STALE_MS) delete room.members[userId];
      }
      if (Object.keys(room.members).length === 0 || time - room.createdAt > ROOM_TTL_MS) {
        await closeRoom(room);
        continue;
      }
      if (Object.keys(room.members).length !== before) await write(roomKey(id), room);
      kept.push(room);
    }
    if (kept.length !== ids.length) await write(roomsKey(teamId), kept.map((room) => room.id));
    return kept;
  }

  async function openRooms(teamId: string): Promise<RoomRecord[]> {
    return (await sweep(teamId)).filter((room) => room.closedAt === null);
  }

  async function presenceList(team: TeamRecord, rooms: RoomRecord[]): Promise<Presence[]> {
    const record = (await read(presenceRecordSchema, presenceKey(team.id))) ?? {};
    return Object.entries(record)
      .filter(([userId]) => team.members[userId])
      .map(([userId, entry]) => ({
        userId,
        displayName: nameOf(team, userId),
        inMeetingSince: entry.inMeetingSince,
        roomId: rooms.find((room) => room.members[userId])?.id ?? null,
        updatedAt: entry.updatedAt,
      }));
  }

  /** The caller's open room in this team, if any, and whether it has them as a member. */
  async function requireRoom(team: TeamRecord, roomId: string, userId: string): Promise<RoomRecord> {
    const room = await read(roomRecordSchema, roomKey(roomId));
    if (!room || room.teamId !== team.id) throw new HttpError(404, "Sync not found");
    if (room.closedAt !== null && !room.mergedInto) throw new HttpError(404, "Sync has ended");
    if (!room.members[userId]) throw new HttpError(403, "Not in this sync");
    return room;
  }

  async function leaveRooms(team: TeamRecord, userId: string, except: string | null = null): Promise<void> {
    for (const room of await openRooms(team.id)) {
      if (room.id === except || !room.members[userId]) continue;
      delete room.members[userId];
      room.invited = room.invited.filter((id) => id !== userId);
      if (Object.keys(room.members).length === 0) await closeRoom(room);
      else await write(roomKey(room.id), room);
    }
  }

  async function uniqueRoomCode(teamId: string): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = randomWords();
      if ((await storage.get(roomCodeKey(teamId, code))) === undefined) return code;
    }
    return `${randomWords()}-${randomIndex(1000)}`;
  }

  function roomResponse(team: TeamRecord, room: RoomRecord) {
    return { room: roomView(team, room), cursor: room.nextSeq - 1 };
  }

  async function addMember(team: TeamRecord, room: RoomRecord, userId: string): Promise<RoomRecord> {
    await leaveRooms(team, userId, room.id);
    const time = now();
    room.members[userId] = { joinedAt: room.members[userId]?.joinedAt ?? time, lastSeen: time };
    await write(roomKey(room.id), room);
    return room;
  }

  async function me(identity: Identity) {
    const team = await teamOf(identity.userId);
    const displayName = identity.name ?? team?.members[identity.userId]?.displayName ?? null;
    return { userId: identity.userId, displayName, team: team ? teamView(team) : null };
  }

  return {
    me,

    async setProfile(identity: Identity, displayName: string) {
      const team = await teamOf(identity.userId);
      const member = team?.members[identity.userId];
      if (team && member) {
        team.members[identity.userId] = { ...member, displayName: identity.name ?? displayName };
        await write(teamKey(team.id), team);
      }
      return me(identity);
    },

    async createTeam(identity: Identity, name: string, displayName: string): Promise<Team> {
      if (await teamOf(identity.userId)) throw new HttpError(409, "Already on a team. Leave it first.");
      let inviteCode = randomInviteCode();
      while ((await storage.get(`invite:${inviteCode}`)) !== undefined) inviteCode = randomInviteCode();
      const time = now();
      const team: TeamRecord = {
        id: crypto.randomUUID(),
        name,
        inviteCode,
        createdBy: identity.userId,
        createdAt: time,
        members: { [identity.userId]: { displayName: identity.name ?? displayName, joinedAt: time } },
      };
      await write(teamKey(team.id), team);
      await storage.put(`invite:${inviteCode}`, team.id);
      await storage.put(`user:${identity.userId}`, team.id);
      return teamView(team);
    },

    async joinTeam(identity: Identity, input: string, displayName: string): Promise<Team> {
      const code = parseInviteCode(input);
      const teamId = code ? await storage.get(`invite:${code}`) : undefined;
      const team = teamId === undefined ? null : await read(teamRecordSchema, teamKey(teamId));
      if (!team) throw new HttpError(404, "No team with that invite code");
      const current = await teamOf(identity.userId);
      if (current && current.id !== team.id) throw new HttpError(409, "Already on another team. Leave it first.");
      team.members[identity.userId] = { displayName: identity.name ?? displayName, joinedAt: team.members[identity.userId]?.joinedAt ?? now() };
      await write(teamKey(team.id), team);
      await storage.put(`user:${identity.userId}`, team.id);
      return teamView(team);
    },

    async leaveTeam(identity: Identity): Promise<void> {
      const team = await requireTeam(identity);
      await leaveRooms(team, identity.userId);
      const presence = (await read(presenceRecordSchema, presenceKey(team.id))) ?? {};
      delete presence[identity.userId];
      await write(presenceKey(team.id), presence);
      delete team.members[identity.userId];
      await storage.delete(`user:${identity.userId}`);
      if (Object.keys(team.members).length === 0) {
        await storage.delete(teamKey(team.id));
        await storage.delete(`invite:${team.inviteCode}`);
        await storage.delete(presenceKey(team.id));
      } else {
        await write(teamKey(team.id), team);
      }
    },

    async setPresence(identity: Identity, inMeeting: boolean): Promise<Presence[]> {
      const team = await requireTeam(identity);
      const record: PresenceRecord = (await read(presenceRecordSchema, presenceKey(team.id))) ?? {};
      const time = now();
      const previous = record[identity.userId];
      record[identity.userId] = { inMeetingSince: inMeeting ? (previous?.inMeetingSince ?? time) : null, updatedAt: time };
      await write(presenceKey(team.id), record);
      return presenceList(team, await openRooms(team.id));
    },

    async listPresence(identity: Identity): Promise<Presence[]> {
      const team = await requireTeam(identity);
      return presenceList(team, await openRooms(team.id));
    },

    async listRooms(identity: Identity): Promise<{ rooms: Room[]; presence: Presence[] }> {
      const team = await requireTeam(identity);
      const rooms = await openRooms(team.id);
      return { rooms: rooms.map((room) => roomView(team, room)), presence: await presenceList(team, rooms) };
    },

    async createRoom(identity: Identity, invite: string[]) {
      const team = await requireTeam(identity);
      await leaveRooms(team, identity.userId);
      const time = now();
      const room: RoomRecord = {
        id: crypto.randomUUID(),
        teamId: team.id,
        code: await uniqueRoomCode(team.id),
        createdAt: time,
        createdBy: identity.userId,
        members: { [identity.userId]: { joinedAt: time, lastSeen: time } },
        invited: [...new Set(invite)].filter((userId) => userId !== identity.userId && team.members[userId]),
        mergeWith: null,
        mergedInto: null,
        closedAt: null,
        nextSeq: 1,
      };
      await write(roomKey(room.id), room);
      await storage.put(roomCodeKey(team.id, room.code), room.id);
      const ids = (await read(idListSchema, roomsKey(team.id))) ?? [];
      await write(roomsKey(team.id), [...ids, room.id]);
      return roomResponse(team, room);
    },

    async joinRoom(identity: Identity, target: { roomId: string } | { code: string }) {
      const team = await requireTeam(identity);
      await sweep(team.id);
      const roomId = "roomId" in target ? target.roomId : await storage.get(roomCodeKey(team.id, normaliseRoomCode(target.code)));
      const room = roomId === undefined ? null : await read(roomRecordSchema, roomKey(roomId));
      if (!room || room.teamId !== team.id || room.closedAt !== null) throw new HttpError(404, "No open sync with that code");
      return roomResponse(team, await addMember(team, room, identity.userId));
    },

    async leaveRoom(identity: Identity, roomId: string): Promise<void> {
      const team = await requireTeam(identity);
      const room = await read(roomRecordSchema, roomKey(roomId));
      if (!room || room.teamId !== team.id || room.closedAt !== null || !room.members[identity.userId]) return;
      delete room.members[identity.userId];
      if (Object.keys(room.members).length === 0) await closeRoom(room);
      else await write(roomKey(room.id), room);
    },

    async invite(identity: Identity, roomId: string, userIds: string[]) {
      const team = await requireTeam(identity);
      const room = await requireRoom(team, roomId, identity.userId);
      const add = userIds.filter((userId) => team.members[userId] && !room.members[userId]);
      room.invited = [...new Set([...room.invited, ...add])];
      await write(roomKey(room.id), room);
      return roomResponse(team, room);
    },

    /** Records this room's vote; when the other room has voted back, the later room's members move to the earlier. */
    async requestMerge(identity: Identity, roomId: string, targetRoomId: string) {
      const team = await requireTeam(identity);
      const room = await requireRoom(team, roomId, identity.userId);
      const target = await read(roomRecordSchema, roomKey(targetRoomId));
      if (!target || target.teamId !== team.id || target.closedAt !== null || target.id === room.id) {
        throw new HttpError(404, "That sync has ended");
      }
      room.mergeWith = target.id;
      if (target.mergeWith !== room.id) {
        await write(roomKey(room.id), room);
        return roomResponse(team, room);
      }
      const roomFirst = room.createdAt < target.createdAt || (room.createdAt === target.createdAt && room.id < target.id);
      const [keep, drop] = roomFirst ? [room, target] : [target, room];
      const time = now();
      for (const [userId, member] of Object.entries(drop.members)) keep.members[userId] = { ...member, lastSeen: time };
      keep.invited = [...new Set([...keep.invited, ...drop.invited])].filter((userId) => !keep.members[userId]);
      keep.mergeWith = null;
      drop.mergedInto = keep.id;
      await write(roomKey(keep.id), keep);
      await closeRoom(drop);
      return roomResponse(team, keep);
    },

    async publish(identity: Identity, roomId: string, text: string, spokenAt: number): Promise<Phrase> {
      const team = await requireTeam(identity);
      const room = await requireRoom(team, roomId, identity.userId);
      if (room.mergedInto) throw new HttpError(409, "Sync was merged");
      const serverTs = now();
      const phrase = {
        seq: room.nextSeq,
        speakerId: identity.userId,
        text: text.slice(0, TEXT_MAX),
        spokenAt: Math.min(serverTs, Math.max(serverTs - SPOKEN_AT_MAX_LAG_MS, spokenAt)),
        serverTs,
      };
      const phrases = (await read(phraseRecordSchema, phrasesKey(room.id))) ?? [];
      await write(phrasesKey(room.id), [...phrases, phrase].slice(-PHRASES_MAX));
      room.nextSeq += 1;
      room.members[identity.userId] = { joinedAt: room.members[identity.userId]?.joinedAt ?? serverTs, lastSeen: serverTs };
      await write(roomKey(room.id), room);
      return { ...phrase, roomId: room.id, speakerName: nameOf(team, identity.userId) };
    },

    async phrases(identity: Identity, roomId: string, after: number): Promise<{ room: Room; phrases: Phrase[] }> {
      const team = await requireTeam(identity);
      await sweep(team.id);
      const room = await requireRoom(team, roomId, identity.userId);
      if (room.mergedInto) return { room: roomView(team, room), phrases: [] };
      const member = room.members[identity.userId];
      if (member) member.lastSeen = now();
      await write(roomKey(room.id), room);
      const phrases = ((await read(phraseRecordSchema, phrasesKey(room.id))) ?? [])
        .filter((phrase) => phrase.seq > after)
        .map((phrase) => ({ ...phrase, roomId: room.id, speakerName: nameOf(team, phrase.speakerId) }));
      return { room: roomView(team, room), phrases };
    },
  };
}

export type RelayState = ReturnType<typeof createRelayState>;
