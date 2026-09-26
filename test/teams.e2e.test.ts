import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { startMemoryRelay } from "../relay/src/memory";
import { createTestIssuer } from "../relay/src/test-issuer";
import { createRelayClient } from "../src/core/relay-client";
import { meetingSummaryResultSchema, roomOptionSchema } from "../src/shared/ipc";
import { runHarness } from "./e2e/run";

// Electron E2E of Teams mode, no Gateway key needed: Bee's real preload and main (teams-sync.ts, stub detector) as
// "Alice", against the in-memory relay served over HTTP with real RS256 tokens and JWKS checks. This test plays
// "Bob": creates the team and a sync, waits for Alice to join, then says one line.

const reportSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    team: z.string().nullable(),
    prompt: z.object({ epoch: z.number(), primary: roomOptionSchema.nullable(), others: z.array(roomOptionSchema) }),
    members: z.array(z.string()),
    sent: z.boolean(),
    mutedSent: z.boolean(),
    peerLines: z.array(z.string()),
    summary: meetingSummaryResultSchema,
    leftAfterMs: z.number(),
    leftPrompt: z.null(),
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

describe("Teams mode: popup → join → speaker-labelled sync → leave (Electron E2E)", () => {
  it("syncs mute-gated phrases with server-stamped speakers and writes a labelled summary", async () => {
    const bob = createRelayClient({ baseUrl: relay.url });
    const bobToken = await issuer.token("user_bob", { name: "Bob Jones" });
    const { team } = await bob.createTeam(bobToken, "Acme", "Typed name is ignored");
    await bob.setPresence(bobToken, true);
    const { room } = await bob.createRoom(bobToken, []);

    // Bob: once Alice is in the room, say one line.
    let stop = false;
    const bobSide = (async () => {
      while (!stop) {
        const polled = await bob.phrases(bobToken, room.id, 0);
        if (polled.room.members.some((member) => member.userId === "user_alice")) {
          await bob.publish(bobToken, room.id, "The SSO beta ships to enterprise on the 14th.", Date.now());
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    })();

    const notesDir = join(mkdtempSync(join(tmpdir(), "bee-teams-e2e-")), "notes");
    const report = await runHarness({
      page: "teams-page",
      env: {
        BEE_RELAY_URL: relay.url,
        BEE_E2E_TOKEN: await issuer.token("user_alice"),
        BEE_E2E_INVITE: `bee://team/${team.inviteCode.slice(0, 4)}-${team.inviteCode.slice(4)}`,
        BEE_E2E_NOTES_DIR: notesDir,
        BEE_AI_GATEWAY_API_KEY: "",
      },
      report: reportSchema,
    });
    stop = true;
    await bobSide;
    console.log("E2E report:", JSON.stringify(report, null, 2));
    if (!report.ok) throw new Error(`E2E failed: ${report.error}`);

    expect(report.team).toBe("Acme");
    expect(report.prompt.primary).toMatchObject({ roomId: room.id, label: "Bob Jones", reason: "recent" });
    expect(report.members).toEqual(["Bob Jones", "Alice"]);
    expect(report.sent).toBe(true);
    expect(report.mutedSent).toBe(false);
    expect(report.peerLines).toEqual(["Bob Jones: The SSO beta ships to enterprise on the 14th."]);
    expect(report.leftAfterMs).toBeGreaterThanOrEqual(900);

    // Bob got Alice's shared phrase, stamped as Alice by the relay; the paused one never left her device.
    const phrases = (await bob.phrases(bobToken, room.id, 0)).phrases;
    expect(phrases.map((phrase) => `${phrase.speakerId} ${phrase.speakerName}: ${phrase.text}`)).toEqual([
      "user_alice Alice: I will draft the SSO rollout plan by Monday.",
      "user_bob Bob Jones: The SSO beta ships to enterprise on the 14th.",
    ]);
    // Alice left when "Teams" left the meeting.
    expect((await bob.phrases(bobToken, room.id, 0)).room.members.map((member) => member.userId)).toEqual(["user_bob"]);

    const markdown = readFileSync(report.summary.path, "utf8");
    console.log(markdown);
    expect(report.summary.usedLlm).toBe(false);
    expect(markdown).toContain("- Alice: I will draft the SSO rollout plan by Monday.\n- Bob Jones: The SSO beta ships to enterprise on the 14th.");
    expect(markdown).toContain("## Speakers\n- Alice\n- Bob Jones\n- Partial: only Bee members who joined the sync are captured.");
  });
});
