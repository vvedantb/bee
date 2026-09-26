import { beforeAll, describe, expect, it } from "vitest";
import { RelayError, createRelayClient } from "../../src/core/relay-client";
import { formatInviteCode, inviteLink } from "../../src/core/relay-protocol";
import { createJwksVerifier } from "./jwt";
import { memoryRelayFetch } from "./memory";
import { MEMBER_STALE_MS, ROOM_TTL_MS } from "./state";
import { TEST_ISSUER, createTestIssuer } from "./test-issuer";

type Issuer = Awaited<ReturnType<typeof createTestIssuer>>;
let issuer: Issuer;
let other: Issuer;

beforeAll(async () => {
  issuer = await createTestIssuer();
  // Same kid, different key: its tokens must fail the signature check.
  other = await createTestIssuer();
});

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function relay(clock = { now: Date.now() }) {
  const fetch = memoryRelayFetch({ verify: issuer.verify, now: () => clock.now });
  return { client: createRelayClient({ baseUrl: "https://relay.test/", fetch }), clock, fetch };
}

async function expectStatus(promise: Promise<object>, status: number): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: Error) => caught,
  );
  expect(error).toBeInstanceOf(RelayError);
  if (error instanceof RelayError) expect(error.status).toBe(status);
}

describe("JWT verification (JWKS)", () => {
  it("accepts a live RS256 token and reads sub and name", async () => {
    await expect(issuer.verify(await issuer.token("user_a", { name: "Alice Smith" }))).resolves.toEqual({ userId: "user_a", name: "Alice Smith" });
  });

  it("rejects bad signatures, expired, foreign, early and malformed tokens", async () => {
    const now = Math.floor(Date.now() / 1000);
    const bad = [
      await other.token("user_a"),
      await issuer.sign({ iss: TEST_ISSUER, sub: "user_a", exp: now - 60 }),
      await issuer.sign({ iss: "https://clerk.example.com", sub: "user_a", exp: now + 60 }),
      await issuer.sign({ iss: TEST_ISSUER, sub: "user_a", exp: now + 600, nbf: now + 300 }),
      await issuer.sign({ iss: TEST_ISSUER, sub: "user_a", exp: now + 60 }, "unknown-kid"),
      "not-a-jwt",
      "a.b.c",
    ];
    for (const token of bad) await expect(issuer.verify(token)).rejects.toThrow();
  });

  it("checks the authorised party when configured", async () => {
    const verify = createJwksVerifier({ issuer: TEST_ISSUER, jwksUrl: "https://test.invalid/jwks", fetch: issuer.jwksFetch, authorizedParties: ["bee://renderer"] });
    await expect(verify(await issuer.token("user_a", { azp: "bee://renderer" }))).resolves.toMatchObject({ userId: "user_a" });
    await expect(verify(await issuer.token("user_a", { azp: "https://evil.example" }))).rejects.toThrow("Unauthorised party");
  });

  it("returns 401 for missing or bad tokens", async () => {
    const { fetch, client } = relay();
    expect((await fetch("https://relay.test/v1/me")).status).toBe(401);
    await expectStatus(client.me(await other.token("user_a")), 401);
  });
});

describe("company team", () => {
  it("creates a team, joins by link or code, lists members and leaves", async () => {
    const { client } = relay();
    const alice = await issuer.token("user_alice");
    const bob = await issuer.token("user_bob");
    const carol = await issuer.token("user_carol");

    const { team } = await client.createTeam(alice, "Acme", "Alice");
    expect(team.inviteCode).toMatch(/^[A-Z2-9]{8}$/);
    await expectStatus(client.createTeam(alice, "Second", "Alice"), 409);

    const joined = await client.joinTeam(bob, inviteLink(team.inviteCode), "Bob");
    expect(joined.team.members.map((member) => member.displayName)).toEqual(["Alice", "Bob"]);
    await client.joinTeam(carol, formatInviteCode(team.inviteCode).toLowerCase(), "Carol");
    await expectStatus(client.joinTeam(await issuer.token("user_dan"), "ZZZZ-ZZZZ", "Dan"), 404);

    expect((await client.me(bob)).team?.id).toBe(team.id);
    await client.leaveTeam(carol);
    expect((await client.me(carol)).team).toBeNull();
    expect((await client.me(alice)).team?.members.map((member) => member.userId)).toEqual(["user_alice", "user_bob"]);
    await expectStatus(client.listRooms(carol), 403);
  });

  it("prefers the name claim from the token over the typed name", async () => {
    const { client } = relay();
    const { team } = await client.createTeam(await issuer.token("user_alice", { name: "Alice Smith" }), "Acme", "Typed");
    expect(team.members[0]?.displayName).toBe("Alice Smith");
  });
});

describe("rooms and phrases", () => {
  async function teamOfThree() {
    const setup = relay();
    const alice = await issuer.token("user_alice");
    const bob = await issuer.token("user_bob");
    const carol = await issuer.token("user_carol");
    const { team } = await setup.client.createTeam(alice, "Acme", "Alice");
    await setup.client.joinTeam(bob, team.inviteCode, "Bob");
    await setup.client.joinTeam(carol, team.inviteCode, "Carol");
    return { ...setup, alice, bob, carol, team };
  }

  it("issues random room ids and word codes, and stamps the speaker from the token", async () => {
    const { client, fetch, alice, bob, carol } = await teamOfThree();
    const started = await client.createRoom(alice, ["user_bob", "user_nobody"]);
    expect(started.room.id).toMatch(UUID_V4);
    expect(started.room.code).toMatch(/^[a-z]+-[a-z]+$/);
    expect(started.room.invited).toEqual(["user_bob"]);

    const joined = await client.joinRoom(bob, { code: started.room.code.toUpperCase().replace("-", " ") });
    expect(joined.room.members.map((member) => member.displayName)).toEqual(["Alice", "Bob"]);

    // A client cannot claim to be someone else: extra fields are ignored and the name comes from the token.
    const response = await fetchRaw(fetch, bob, started.room.id, { text: "Ship Friday", spokenAt: Date.now(), speakerName: "Alice" });
    expect(response).toMatchObject({ phrase: { speakerId: "user_bob", speakerName: "Bob", text: "Ship Friday" } });

    const polled = await client.phrases(alice, started.room.id, joined.cursor);
    expect(polled.phrases.map((phrase) => `${phrase.speakerName}: ${phrase.text}`)).toEqual(["Bob: Ship Friday"]);

    // Not a member of the room: cannot read or write it.
    await expectStatus(client.phrases(carol, started.room.id, 0), 403);
    await expectStatus(client.publish(carol, started.room.id, "Hi", Date.now()), 403);
  });

  it("gives late joiners only what is said after they join", async () => {
    const { client, alice, bob } = await teamOfThree();
    const { room } = await client.createRoom(alice, []);
    await client.publish(alice, room.id, "Before Bob", Date.now());
    const joined = await client.joinRoom(bob, { roomId: room.id });
    await client.publish(alice, room.id, "After Bob", Date.now());
    expect((await client.phrases(bob, room.id, joined.cursor)).phrases.map((phrase) => phrase.text)).toEqual(["After Bob"]);
  });

  it("keeps one room per user and closes a room when its last member leaves", async () => {
    const { client, alice, bob } = await teamOfThree();
    const first = await client.createRoom(alice, []);
    await client.createRoom(alice, []);
    expect((await client.listRooms(bob)).rooms.map((room) => room.id)).not.toContain(first.room.id);
    const { rooms } = await client.listRooms(bob);
    await client.leaveRoom(alice, rooms[0]?.id ?? "");
    expect((await client.listRooms(bob)).rooms).toEqual([]);
    await expectStatus(client.joinRoom(bob, { roomId: rooms[0]?.id ?? "" }), 404);
  });

  it("drops members that stop polling and ends rooms after the hard limit", async () => {
    const { client, clock, alice, bob } = await teamOfThree();
    const { room } = await client.createRoom(alice, []);
    await client.joinRoom(bob, { roomId: room.id });
    clock.now += MEMBER_STALE_MS / 2;
    await client.phrases(bob, room.id, 0);
    clock.now += MEMBER_STALE_MS / 2 + 1;
    expect((await client.listRooms(bob)).rooms[0]?.members.map((member) => member.userId)).toEqual(["user_bob"]);
    for (let elapsed = 0; elapsed < ROOM_TTL_MS; elapsed += MEMBER_STALE_MS / 2) {
      clock.now += MEMBER_STALE_MS / 2;
      await client.phrases(bob, room.id, 0).catch(() => null);
    }
    expect((await client.listRooms(bob)).rooms).toEqual([]);
  });

  it("reports team presence with each member's room", async () => {
    const { client, alice, bob } = await teamOfThree();
    await client.setPresence(alice, true);
    const { room } = await client.createRoom(alice, []);
    const { presence } = await client.setPresence(bob, false);
    expect(presence.find((entry) => entry.userId === "user_alice")).toMatchObject({ roomId: room.id });
    expect(presence.find((entry) => entry.userId === "user_bob")).toMatchObject({ inMeetingSince: null, roomId: null });
  });

  it("merges two rooms only after both sides tap", async () => {
    const { client, clock, alice, bob } = await teamOfThree();
    const first = await client.createRoom(alice, []);
    clock.now += 5000;
    const second = await client.createRoom(bob, []);
    const vote = await client.requestMerge(alice, first.room.id, second.room.id);
    expect(vote.room.members).toHaveLength(1);
    const merged = await client.requestMerge(bob, second.room.id, first.room.id);
    expect(merged.room.id).toBe(first.room.id);
    expect(merged.room.members.map((member) => member.userId)).toEqual(["user_alice", "user_bob"]);
    const old = await client.phrases(bob, second.room.id, 0);
    expect(old.room.mergedInto).toBe(first.room.id);
  });
});

// Raw POST, to prove the relay ignores a speakerName in the body.
async function fetchRaw(fetch: typeof globalThis.fetch, token: string, roomId: string, body: object): Promise<object> {
  const response = await fetch(`https://relay.test/v1/rooms/${roomId}/phrases`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json();
}
