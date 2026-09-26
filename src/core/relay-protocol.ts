import { z } from "zod";

// Wire format of the Bee relay (relay/), shared by the Worker, the in-memory mock and the Electron client.
// Speaker identity is never sent by clients: the relay stamps it from the verified Clerk token.

export const TEXT_MAX = 2000;
export const NAME_MAX = 80;

export const memberSchema = z.object({ userId: z.string(), displayName: z.string() });
export type Member = z.infer<typeof memberSchema>;

export const teamSchema = z.object({
  id: z.string(),
  name: z.string(),
  // 8 characters, shown as XXXX-XXXX; the invite link is bee://team/XXXX-XXXX.
  inviteCode: z.string(),
  createdBy: z.string(),
  members: z.array(memberSchema),
});
export type Team = z.infer<typeof teamSchema>;

export const presenceSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  // Server time. Null when not in a meeting (or the client stopped reporting).
  inMeetingSince: z.number().nullable(),
  roomId: z.string().nullable(),
  updatedAt: z.number(),
});
export type Presence = z.infer<typeof presenceSchema>;

export const roomSchema = z.object({
  // Random UUIDv4 from the server. Never derived from time, titles or audio.
  id: z.string(),
  // Word alias such as "amber-otter": team-scoped, expires with the room.
  code: z.string(),
  createdAt: z.number(),
  createdBy: z.string(),
  members: z.array(memberSchema),
  invited: z.array(z.string()),
  // This room has asked to merge with that one; merging needs a tap from both rooms.
  mergeWith: z.string().nullable(),
  // Set once merged: members were moved to that room.
  mergedInto: z.string().nullable(),
});
export type Room = z.infer<typeof roomSchema>;

export const phraseSchema = z.object({
  seq: z.number().int(),
  roomId: z.string(),
  // Stamped by the relay from the Clerk token.
  speakerId: z.string(),
  speakerName: z.string(),
  text: z.string(),
  // When it was spoken, in server time (sender's clock plus its offset, clamped by the relay).
  spokenAt: z.number(),
  serverTs: z.number(),
});
export type Phrase = z.infer<typeof phraseSchema>;

// Requests
export const profileRequestSchema = z.object({ displayName: z.string().trim().min(1).max(NAME_MAX) });
export const createTeamRequestSchema = z.object({ name: z.string().trim().min(1).max(NAME_MAX), displayName: z.string().trim().min(1).max(NAME_MAX) });
export const joinTeamRequestSchema = z.object({ code: z.string().trim().min(1).max(200), displayName: z.string().trim().min(1).max(NAME_MAX) });
export const presenceRequestSchema = z.object({ inMeeting: z.boolean() });
export const createRoomRequestSchema = z.object({ invite: z.array(z.string().max(200)).max(50) });
export const joinRoomRequestSchema = z.union([z.object({ roomId: z.string().max(100) }), z.object({ code: z.string().trim().min(1).max(100) })]);
export const inviteRequestSchema = z.object({ userIds: z.array(z.string().max(200)).min(1).max(50) });
export const mergeRequestSchema = z.object({ targetRoomId: z.string().max(100) });
export const publishRequestSchema = z.object({ text: z.string().trim().min(1).max(TEXT_MAX), spokenAt: z.number() });

// Responses: every one carries serverNow so clients can estimate their clock offset.
const timed = { serverNow: z.number() };
export const meResponseSchema = z.object({ ...timed, userId: z.string(), displayName: z.string().nullable(), team: teamSchema.nullable() });
export const teamResponseSchema = z.object({ ...timed, team: teamSchema });
export const okResponseSchema = z.object({ ...timed, ok: z.literal(true) });
export const presenceResponseSchema = z.object({ ...timed, presence: z.array(presenceSchema) });
export const roomsResponseSchema = z.object({ ...timed, rooms: z.array(roomSchema), presence: z.array(presenceSchema) });
// cursor: the last phrase seq already in the room, so joiners only get what is said after they join.
export const roomResponseSchema = z.object({ ...timed, room: roomSchema, cursor: z.number().int() });
export const publishResponseSchema = z.object({ ...timed, phrase: phraseSchema });
export const phrasesResponseSchema = z.object({ ...timed, room: roomSchema, phrases: z.array(phraseSchema) });
export const errorResponseSchema = z.object({ error: z.string() });

/** Team invite codes: 8 characters from an alphabet without look-alikes, shown as XXXX-XXXX. */
export const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Accepts a code, "XXXX-XXXX", or a bee://team/… link. Returns the bare 8-character code, or null. */
export function parseInviteCode(input: string): string | null {
  const trimmed = input.trim();
  const fromLink = /^bee:\/\/team\/(.+)$/i.exec(trimmed)?.[1] ?? trimmed;
  const code = decodeURIComponent(fromLink).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== 8 || [...code].some((char) => !INVITE_ALPHABET.includes(char))) return null;
  return code;
}

export function formatInviteCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function inviteLink(code: string): string {
  return `bee://team/${formatInviteCode(code)}`;
}

/** Room word codes are lower-case words joined by hyphens: "Amber Otter" → "amber-otter". */
export function normaliseRoomCode(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "");
}
