import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { startMemoryRelay } from "../relay/src/memory";
import { createTestIssuer } from "../relay/src/test-issuer";
import { createRelayClient } from "../src/core/relay-client";
import { teamsViewSchema } from "../src/shared/ipc";
import { runHarness } from "./e2e/run";

// Electron E2E of concurrent meetings, no Gateway key needed. Bob and Carol each run a live sync; "Alice" (Bee's real
// preload and main, stub detector) sees two Teams meeting windows. She must pick a meeting, then a sync: nothing
// joins on its own, dismiss hides the pick, and her phrase reaches only the sync she chose.

const promptSchema = teamsViewSchema.shape.prompt.unwrap();
const reportSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    first: promptSchema,
    dismissedPrompt: z.null(),
    afterDismiss: z.object({ prompt: z.null(), room: z.null() }),
    second: promptSchema,
    picked: promptSchema,
    joinedRoom: z.string().nullable(),
    members: z.array(z.string()),
    sent: z.boolean(),
    settled: z.object({ prompt: z.null(), room: z.string().nullable() }),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

let relay: Awaited<ReturnType<typeof startMemoryRelay>>;
let issuer: Awaited<ReturnType<typeof createTestIssuer>>;

beforeAll(async () => {
  issuer = await createTestIssuer();
  relay = await startMemoryRelay({ verify: issuer.verify });
});

afterAll(() => {
  relay.server.close();
});

describe("Teams mode: two meetings → pick → join the chosen sync (Electron E2E)", () => {
  it("never auto-joins, honours dismiss, and binds Alice to the meeting and sync she picked", async () => {
    const client = createRelayClient({ baseUrl: relay.url });
    const bobToken = await issuer.token("user_bob", { name: "Bob Jones" });
    const carolToken = await issuer.token("user_carol", { name: "Carol King" });
    const { team } = await client.createTeam(bobToken, "Acme", "Bob");
    await client.joinTeam(carolToken, team.inviteCode, "Carol");
    await client.setPresence(bobToken, true);
    const bobRoom = (await client.createRoom(bobToken, [])).room;
    await client.setPresence(carolToken, true);
    const carolRoom = (await client.createRoom(carolToken, [])).room;

    // Bob and Carol stay present and in their rooms while Alice runs.
    let stop = false;
    const peers = (async () => {
      while (!stop) {
        for (const [token, room] of [[bobToken, bobRoom], [carolToken, carolRoom]] as const) {
          await client.setPresence(token, true);
          await client.phrases(token, room.id, 0);
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    })();

    const report = await runHarness({
      page: "teams-pick-page",
      env: {
        BEE_RELAY_URL: relay.url,
        BEE_E2E_TOKEN: await issuer.token("user_alice"),
        BEE_E2E_INVITE: `bee://team/${team.inviteCode.slice(0, 4)}-${team.inviteCode.slice(4)}`,
        BEE_AI_GATEWAY_API_KEY: "",
      },
      report: reportSchema,
    });
    stop = true;
    await peers;
    console.log("E2E report:", JSON.stringify(report, null, 2));
    if (!report.ok) throw new Error(`E2E failed: ${report.error}`);

    const labels = ["Meeting with Bob", "Call with Carol"];
    // Detection 1: "Which meeting?" with no one-click room; dismiss hid it and nothing joined.
    expect(report.first.meetings.map((meeting) => meeting.label)).toEqual(labels);
    expect(report.first).toMatchObject({ primary: null, selectedMeetingKey: null, ambiguous: true });
    expect(report.first.others.map((option) => option.roomId).sort()).toEqual([bobRoom.id, carolRoom.id].sort());
    expect(report.afterDismiss).toEqual({ prompt: null, room: null });

    // Detection 2: picked Carol's call; still no default sync, so Alice chose Carol's.
    expect(report.second.epoch).toBeGreaterThan(report.first.epoch);
    expect(report.second).toMatchObject({ primary: null, selectedMeetingKey: null });
    expect(report.picked).toMatchObject({ primary: null, ambiguous: true, selectedMeetingKey: "call with carol" });
    expect(report.joinedRoom).toBe(carolRoom.id);
    expect(report.members).toEqual(["Carol King", "Alice"]);
    expect(report.sent).toBe(true);
    expect(report.settled).toEqual({ prompt: null, room: carolRoom.id });

    // Relay side: Alice is only in Carol's sync, and her phrase went only there.
    const bobSide = await client.phrases(bobToken, bobRoom.id, 0);
    const carolSide = await client.phrases(carolToken, carolRoom.id, 0);
    expect(bobSide.room.members.map((member) => member.userId)).toEqual(["user_bob"]);
    expect(carolSide.room.members.map((member) => member.userId)).toEqual(["user_carol", "user_alice"]);
    expect(bobSide.phrases).toEqual([]);
    expect(carolSide.phrases.map((phrase) => `${phrase.speakerName}: ${phrase.text}`)).toEqual(["Alice: Carol's call: budget review moves to Thursday."]);
  });
});
