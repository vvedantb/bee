import { describe, expect, it } from "vitest";
import type { Presence, Room } from "./relay-protocol";
import { inviteRoster, mergeCandidate, namesLabel, rankRooms } from "./room-picker";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function room(id: string, createdAt: number, members: string[], extra: Partial<Room> = {}): Room {
  return {
    id,
    code: `${id}-code`,
    createdAt,
    createdBy: members[0] ?? "nobody",
    members: members.map((userId) => ({ userId, displayName: userId[0]?.toUpperCase() + userId.slice(1) })),
    invited: [],
    mergeWith: null,
    mergedInto: null,
    ...extra,
  };
}

function present(userId: string, inMeeting = true, updatedAt = NOW - 5000): Presence {
  return { userId, displayName: userId, inMeetingSince: inMeeting ? NOW - 2 * MIN : null, roomId: null, updatedAt };
}

describe("namesLabel", () => {
  it("shows two names and a count", () => {
    expect(namesLabel(["Alice"])).toBe("Alice");
    expect(namesLabel(["Alice", "Bob"])).toBe("Alice, Bob");
    expect(namesLabel(["Alice", "Bob", "Carol", "Dan"])).toBe("Alice, Bob +2");
  });
});

describe("rankRooms", () => {
  const mySince = NOW - MIN;

  it("puts rooms I was invited to first, then recent rooms with someone in a meeting", () => {
    const rooms = [
      room("recent", NOW - 2 * MIN, ["bob"]),
      room("invited", NOW - 30 * MIN, ["carol"], { invited: ["me"] }),
      room("stale", NOW - 3 * MIN, ["dan"]),
      room("old", NOW - 40 * MIN, ["erin"]),
    ];
    const presence = [present("bob"), present("carol", false), present("dan", true, NOW - 5 * MIN), present("erin")];
    const choices = rankRooms({ rooms, presence, me: "me", mySince, now: NOW });
    expect(choices.primary).toMatchObject({ roomId: "invited", reason: "invited", invitedBy: "Carol", label: "Carol", ageMinutes: 30 });
    expect(choices.others.map((option) => [option.roomId, option.reason])).toEqual([
      ["recent", "recent"],
      // Dan's presence is stale and Erin's room started too long ago: listed, never the default.
      ["stale", "other"],
      ["old", "other"],
    ]);
  });

  it("has no default when two recent rooms look equally live, ordered by how close they started", () => {
    const rooms = [room("far", NOW - 9 * MIN, ["bob"]), room("near", NOW - 2 * MIN, ["carol"])];
    const choices = rankRooms({ rooms, presence: [present("bob"), present("carol")], me: "me", mySince, now: NOW });
    expect(choices.primary).toBeNull();
    expect(choices.ambiguous).toBe(true);
    expect(choices.others.map((option) => option.roomId)).toEqual(["near", "far"]);
  });

  it("keeps one recent room as the default, and one invite over several recent rooms", () => {
    const presence = [present("bob"), present("carol"), present("dan")];
    const single = rankRooms({ rooms: [room("near", NOW - 2 * MIN, ["bob"])], presence, me: "me", mySince, now: NOW });
    expect(single).toMatchObject({ primary: { roomId: "near" }, ambiguous: false });
    const rooms = [room("a", NOW - 2 * MIN, ["bob"]), room("b", NOW - 3 * MIN, ["carol"]), room("inv", NOW - 4 * MIN, ["dan"], { invited: ["me"] })];
    expect(rankRooms({ rooms, presence, me: "me", mySince, now: NOW })).toMatchObject({ primary: { roomId: "inv" }, ambiguous: false });
    const twoInvites = [...rooms, room("inv2", NOW - 5 * MIN, ["erin"], { invited: ["me"] })];
    const choices = rankRooms({ rooms: twoInvites, presence, me: "me", mySince, now: NOW });
    expect(choices).toMatchObject({ primary: null, ambiguous: true });
    expect(choices.others.map((option) => option.roomId)).toEqual(["inv", "inv2", "a", "b"]);
  });

  it("never makes an unmatched room the one-click default", () => {
    const choices = rankRooms({ rooms: [room("other", NOW - 50 * MIN, ["bob"])], presence: [present("bob")], me: "me", mySince, now: NOW });
    expect(choices.primary).toBeNull();
    expect(choices.others.map((option) => option.roomId)).toEqual(["other"]);
  });

  it("skips my own room, empty rooms and merged rooms", () => {
    const rooms = [room("mine", NOW, ["me", "bob"]), room("empty", NOW, []), room("merged", NOW, ["carol"], { mergedInto: "x" })];
    expect(rankRooms({ rooms, presence: [present("bob"), present("carol")], me: "me", mySince, now: NOW })).toEqual({ primary: null, others: [], ambiguous: false });
  });
});

describe("inviteRoster", () => {
  it("lists teammates in a meeting who are not already in my room", () => {
    const mine = room("mine", NOW, ["me", "bob"]);
    const presence = [present("me"), present("bob"), present("carol"), present("dan", false), present("erin", true, NOW - 10 * MIN)];
    expect(inviteRoster({ presence, room: mine, me: "me", now: NOW }).map((member) => member.userId)).toEqual(["carol"]);
  });
});

describe("mergeCandidate", () => {
  it("offers a room started within 30 s by a teammate in a meeting", () => {
    const mine = room("mine", NOW, ["me"]);
    const rooms = [mine, room("twin", NOW + 20_000, ["bob"]), room("later", NOW + 45_000, ["carol"])];
    expect(mergeCandidate({ rooms, presence: [present("bob"), present("carol")], mine, now: NOW })?.id).toBe("twin");
    expect(mergeCandidate({ rooms, presence: [present("carol")], mine, now: NOW })).toBeNull();
  });
});
