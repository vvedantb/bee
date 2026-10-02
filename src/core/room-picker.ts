import type { Member, Presence, Room } from "./relay-protocol";

// Ranks the open syncs shown when a Teams meeting is detected. Signals only rank; membership is always a click.

// Rooms started this close to my own detection count as "recent".
export const RECENT_WINDOW_MS = 10 * 60_000;
// Two rooms started this close together by teammates both in a meeting may be one meeting: offer a merge.
export const MERGE_WINDOW_MS = 30_000;
// Presence older than this is treated as not in a meeting (the client stopped reporting).
export const PRESENCE_STALE_MS = 60_000;

export type RoomOption = {
  roomId: string;
  code: string;
  names: string[];
  // "Alice, Bob" or "Alice, Bob +2".
  label: string;
  reason: "invited" | "recent" | "other";
  createdAt: number;
  // Whole minutes since the room started.
  ageMinutes: number;
  // Who invited me, when reason is "invited".
  invitedBy: string | null;
};

// ambiguous: two or more rooms match equally well, so there is no one-click default and the user picks.
export type RoomChoices = { primary: RoomOption | null; others: RoomOption[]; ambiguous: boolean };

export function namesLabel(names: string[], max = 2): string {
  if (names.length === 0) return "nobody yet";
  const shown = names.slice(0, max).join(", ");
  return names.length > max ? `${shown} +${names.length - max}` : shown;
}

/** Teammates whose client reported "in a meeting" within the last minute. */
export function inMeetingIds(presence: Presence[], now: number): Set<string> {
  return new Set(presence.filter((entry) => entry.inMeetingSince !== null && now - entry.updatedAt <= PRESENCE_STALE_MS).map((entry) => entry.userId));
}

function option(room: Room, reason: RoomOption["reason"], me: string, now: number): RoomOption {
  const names = room.members.filter((member) => member.userId !== me).map((member) => member.displayName);
  const creator = room.members.find((member) => member.userId === room.createdBy)?.displayName ?? null;
  return { roomId: room.id, code: room.code, names, label: namesLabel(names), reason, createdAt: room.createdAt, ageMinutes: Math.max(0, Math.floor((now - room.createdAt) / 60_000)), invitedBy: reason === "invited" ? creator : null };
}

/**
 * Invited rooms first (newest first), then rooms started within ±10 minutes of my detection that have a member
 * currently in a meeting (closest start first), then everything else. The primary button is the top one, unless
 * two or more rooms share the top tier (two invites, or two live recent syncs): then nothing is the default.
 */
export function rankRooms(args: { rooms: Room[]; presence: Presence[]; me: string; mySince: number; now: number }): RoomChoices {
  const live = inMeetingIds(args.presence, args.now);
  const open = args.rooms.filter(
    (room) => room.mergedInto === null && room.members.length > 0 && !room.members.some((member) => member.userId === args.me),
  );
  const invited: RoomOption[] = [];
  const recent: RoomOption[] = [];
  const other: RoomOption[] = [];
  for (const room of open) {
    if (room.invited.includes(args.me)) invited.push(option(room, "invited", args.me, args.now));
    else if (Math.abs(room.createdAt - args.mySince) <= RECENT_WINDOW_MS && room.members.some((member) => live.has(member.userId)))
      recent.push(option(room, "recent", args.me, args.now));
    else other.push(option(room, "other", args.me, args.now));
  }
  invited.sort((a, b) => b.createdAt - a.createdAt);
  recent.sort((a, b) => Math.abs(a.createdAt - args.mySince) - Math.abs(b.createdAt - args.mySince));
  other.sort((a, b) => b.createdAt - a.createdAt);
  const ranked = [...invited, ...recent, ...other];
  // An "other" room is never the one-click default: it did not match any signal.
  const ambiguous = (invited.length > 0 ? invited : recent).length > 1;
  const primary = !ambiguous && ranked[0] && ranked[0].reason !== "other" ? ranked[0] : null;
  return { primary, others: primary ? ranked.slice(1) : ranked, ambiguous };
}

/** Invite roster after starting: teammates in a meeting now and not already in my room. Nobody is pre-ticked. */
export function inviteRoster(args: { presence: Presence[]; room: Room; me: string; now: number }): Member[] {
  const live = inMeetingIds(args.presence, args.now);
  const inRoom = new Set(args.room.members.map((member) => member.userId));
  return args.presence
    .filter((entry) => entry.userId !== args.me && live.has(entry.userId) && !inRoom.has(entry.userId))
    .map((entry) => ({ userId: entry.userId, displayName: entry.displayName }));
}

/**
 * Another room started within 30 s of mine by a teammate who is in a meeting: the two starts were probably
 * the same call. Returns that room so both sides can be asked "Merge with Bob's sync?".
 */
export function mergeCandidate(args: { rooms: Room[]; presence: Presence[]; mine: Room; now: number }): Room | null {
  const live = inMeetingIds(args.presence, args.now);
  const candidates = args.rooms.filter(
    (room) =>
      room.id !== args.mine.id &&
      room.mergedInto === null &&
      Math.abs(room.createdAt - args.mine.createdAt) <= MERGE_WINDOW_MS &&
      live.has(room.createdBy),
  );
  candidates.sort((a, b) => Math.abs(a.createdAt - args.mine.createdAt) - Math.abs(b.createdAt - args.mine.createdAt));
  return candidates[0] ?? null;
}
