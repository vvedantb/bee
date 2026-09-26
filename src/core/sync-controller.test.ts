import { beforeAll, describe, expect, it } from "vitest";
import { memoryRelayFetch } from "../../relay/src/memory";
import { createTestIssuer } from "../../relay/src/test-issuer";
import { ENTER_STABLE_MS, LEAVE_DEBOUNCE_MS } from "./meeting-tracker";
import type { TeamsActionInput } from "../shared/ipc";
import { createSyncController } from "./sync-controller";

type Issuer = Awaited<ReturnType<typeof createTestIssuer>>;
let issuer: Issuer;
beforeAll(async () => {
  issuer = await createTestIssuer();
});

// Two (or three) devices on one in-memory relay, each with a stub Teams detector, all on a shared fake clock.
async function setup(names: string[]) {
  const clock = { now: 1_800_000_000_000 };
  const fetch = memoryRelayFetch({ verify: issuer.verify, now: () => clock.now });
  const devices = await Promise.all(
    names.map(async (name) => {
      const detector = { inMeeting: false };
      const sync = createSyncController({
        relayUrl: "https://relay.test",
        fetch,
        now: () => clock.now,
        readDetector: async () => ({ inMeeting: detector.inMeeting, source: "windows" }),
      });
      const sessionToken = await issuer.token(`user_${name.toLowerCase()}`);
      return { name, sync, detector, sessionToken };
    }),
  );
  return { clock, devices };
}

function need<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing test device");
  return value;
}

type Device = Awaited<ReturnType<typeof setup>>["devices"][number];

async function act(device: Device, action: TeamsActionInput) {
  const result = await device.sync.act({ ...action, sessionToken: device.sessionToken });
  expect(result.error).toBeNull();
  return result.view;
}

const tick = (device: Device) => device.sync.tick(device.sessionToken);

/** Everyone reports "in a meeting" long enough for the popup. */
async function enterMeeting(clock: { now: number }, devices: Device[]): Promise<void> {
  for (const device of devices) {
    device.detector.inMeeting = true;
    await tick(device);
  }
  clock.now += ENTER_STABLE_MS;
  for (const device of devices) await tick(device);
}

async function teamOf(names: string[]) {
  const { clock, devices } = await setup(names);
  const [first, ...rest] = devices;
  if (!first) throw new Error("no devices");
  const created = await act(first, { type: "createTeam", name: "Acme", displayName: first.name });
  for (const device of rest) await act(device, { type: "joinTeam", code: created.team?.inviteLink ?? "", displayName: device.name });
  return { clock, devices, first };
}

describe("sync controller", () => {
  it("joins a team by invite link and lists members", async () => {
    const { devices } = await teamOf(["Alice", "Bob"]);
    const view = (await tick(need(devices[1]))).view;
    expect(view.team?.members.map((member) => member.displayName)).toEqual(["Alice", "Bob"]);
    expect(view.team?.inviteLink).toMatch(/^bee:\/\/team\/[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const bad = await need(devices[0]).sync.act({ type: "joinTeam", code: "nope", displayName: "X", sessionToken: need(devices[0]).sessionToken });
    expect(bad.error).toMatch(/does not look right/);
  });

  it("shows the popup only after a stable detection, then Join \"Alice\" syncs phrases with speaker names", async () => {
    const { clock, devices } = await teamOf(["Alice", "Bob"]);
    const alice = need(devices[0]);
    const bob = need(devices[1]);
    alice.detector.inMeeting = true;
    expect((await tick(alice)).view.prompt).toBeNull();
    clock.now += ENTER_STABLE_MS / 2;
    expect((await tick(alice)).view.prompt).toBeNull();
    clock.now += ENTER_STABLE_MS / 2;
    const prompt = (await tick(alice)).view.prompt;
    expect(prompt).toEqual({ epoch: 1, primary: null, others: [] });

    const started = await act(alice, { type: "startSync", invite: [] });
    expect(started.room).toMatchObject({ startedByMe: true });
    expect(started.prompt).toBeNull();

    await enterMeeting(clock, [bob]);
    const bobPrompt = (await tick(bob)).view.prompt;
    expect(bobPrompt?.primary).toMatchObject({ roomId: started.room?.id, label: "Alice", reason: "recent" });

    const joined = await act(bob, { type: "joinSync", roomId: bobPrompt?.primary?.roomId ?? "" });
    expect(joined.room?.members.map((member) => member.displayName)).toEqual(["Alice", "Bob"]);

    // Mic phrases are shared; typed lines and paused sharing are not.
    const publish = (text: string, source: "mic" | "typed") =>
      alice.sync.publish({ text, clientTs: clock.now, source, sessionToken: alice.sessionToken });
    expect(await publish("We ship on Friday.", "mic")).toEqual({ sent: true, error: null });
    expect(await publish("typed test line", "typed")).toEqual({ sent: false, error: null });
    await act(alice, { type: "setShareMuted", muted: true });
    expect(await publish("private aside", "mic")).toEqual({ sent: false, error: null });

    const received = (await tick(bob)).lines;
    expect(received.map((line) => ({ own: line.own, speakerName: line.speakerName, text: line.text }))).toEqual([
      { own: false, speakerName: "Alice", text: "We ship on Friday." },
    ]);
    expect(received[0]?.clientTs).toBeLessThanOrEqual(clock.now);
    // Own phrases are not echoed back.
    await bob.sync.publish({ text: "Sounds good.", clientTs: clock.now, source: "mic", sessionToken: bob.sessionToken });
    expect((await tick(bob)).lines).toEqual([]);
    expect((await tick(alice)).lines.map((line) => `${line.speakerName}: ${line.text}`)).toEqual(["Bob: Sounds good."]);
  });

  it("leaves after Teams has been out of the meeting for the debounce, and never rejoins on its own", async () => {
    const { clock, devices } = await teamOf(["Alice", "Bob"]);
    const alice = need(devices[0]);
    const bob = need(devices[1]);
    await enterMeeting(clock, [alice, bob]);
    const room = (await act(alice, { type: "startSync", invite: [] })).room;
    await act(bob, { type: "joinSync", roomId: room?.id ?? "" });

    bob.detector.inMeeting = false;
    await tick(bob);
    clock.now += LEAVE_DEBOUNCE_MS - 1000;
    await tick(alice);
    expect((await tick(bob)).view.room?.id).toBe(room?.id);
    clock.now += 1000;
    await tick(alice);
    expect((await tick(bob)).view.room).toBeNull();

    // Next detection: a fresh popup offering Alice's sync, not an automatic rejoin.
    bob.detector.inMeeting = true;
    await tick(bob);
    clock.now += ENTER_STABLE_MS;
    await tick(alice);
    const view = (await tick(bob)).view;
    expect(view.room).toBeNull();
    expect(view.prompt).toMatchObject({ epoch: 2, primary: { roomId: room?.id } });
  });

  it("keeps concurrent meetings apart: Carol sees Alice's sync by name and starts her own", async () => {
    const { clock, devices } = await teamOf(["Alice", "Bob", "Carol"]);
    const [alice, bob, carol] = [need(devices[0]), need(devices[1]), need(devices[2])];
    await enterMeeting(clock, [alice, bob, carol]);
    const aliceRoom = (await act(alice, { type: "startSync", invite: ["user_bob"] })).room;
    const bobPrompt = (await tick(bob)).view.prompt;
    expect(bobPrompt?.primary).toMatchObject({ reason: "invited", invitedBy: "Alice" });
    await act(bob, { type: "joinSync", roomId: aliceRoom?.id ?? "" });

    const carolPrompt = (await tick(carol)).view.prompt;
    expect(carolPrompt?.primary?.label).toBe("Alice, Bob");
    clock.now += 60_000;
    await tick(alice);
    await tick(bob);
    const carolRoom = (await act(carol, { type: "startSync", invite: [] })).room;
    expect(carolRoom?.id).not.toBe(aliceRoom?.id);
    expect((await tick(alice)).view.room?.members.map((member) => member.displayName)).toEqual(["Alice", "Bob"]);
    // Started a minute apart: no merge offer.
    expect((await tick(carol)).view.merge).toBeNull();
  });

  it("offers a merge for two syncs started within 30 s, and merges once both tap", async () => {
    const { clock, devices } = await teamOf(["Alice", "Bob"]);
    const [alice, bob] = [need(devices[0]), need(devices[1])];
    await enterMeeting(clock, [alice, bob]);
    const aliceRoom = (await act(alice, { type: "startSync", invite: [] })).room;
    clock.now += 5000;
    await act(bob, { type: "startSync", invite: [] });
    const offer = (await tick(alice)).view.merge;
    expect(offer).toMatchObject({ label: "Merge with Bob's sync?", waiting: false });
    expect((await act(alice, { type: "merge", accept: true })).merge?.waiting).toBe(true);
    await tick(bob);
    const merged = await act(bob, { type: "merge", accept: true });
    expect(merged.room?.id).toBe(aliceRoom?.id);
    expect((await tick(alice)).view.room?.members.map((member) => member.displayName)).toEqual(["Alice", "Bob"]);
  });

  it("dismissing the popup hides it for this meeting", async () => {
    const { clock, devices } = await teamOf(["Alice"]);
    const alice = need(devices[0]);
    await enterMeeting(clock, [alice]);
    expect((await tick(alice)).view.prompt).not.toBeNull();
    expect((await act(alice, { type: "dismissPrompt" })).prompt).toBeNull();
    expect((await tick(alice)).view.prompt).toBeNull();
  });

  it("simulated meetings drive detection on platforms without a detector", async () => {
    const { clock, devices } = await teamOf(["Alice"]);
    const alice = need(devices[0]);
    await act(alice, { type: "simulateMeeting", on: true });
    await tick(alice);
    clock.now += ENTER_STABLE_MS;
    const view = (await tick(alice)).view;
    expect(view.detection).toMatchObject({ inMeeting: true, source: "simulated" });
    expect(view.prompt).not.toBeNull();
  });

  it("fails open when the relay is down, and is off without BEE_RELAY_URL", async () => {
    const down = createSyncController({
      relayUrl: "https://relay.test",
      fetch: async () => {
        throw new Error("connect ECONNREFUSED");
      },
      readDetector: async () => ({ inMeeting: true, source: "windows" }),
    });
    const token = await issuer.token("user_alice");
    const result = await down.tick(token);
    expect(result.lines).toEqual([]);
    expect(result.view.relayError).toMatch(/Relay unreachable: connect ECONNREFUSED\. Bee is working solo\./);
    expect(await down.publish({ text: "Hi", clientTs: 0, source: "mic", sessionToken: token })).toEqual({ sent: false, error: null });

    const off = createSyncController({ relayUrl: null, readDetector: async () => ({ inMeeting: false, source: "none" }) });
    expect((await off.tick(token)).view).toMatchObject({ relayConfigured: false, team: null, prompt: null });
    expect((await off.act({ type: "startSync", invite: [], sessionToken: token })).error).toMatch(/BEE_RELAY_URL/);
  });
});
