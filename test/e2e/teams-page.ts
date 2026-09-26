// Runs in the sandboxed harness renderer as "Alice": join the team by invite link, simulate a Teams meeting, take
// the popup's Join, share one mic phrase (and one while sharing is paused), receive Bob's phrase, save the
// speaker-labelled summary, then leave Teams and check the sync ends. Reports once, via console, to harness-main.ts.
import { mergeLines, summaryTranscript, type SessionLine } from "../../src/core/sync-lines";
import type { TeamsActionInput, TeamsView } from "../../src/shared/ipc";

const query = new URLSearchParams(location.search);
const sessionToken = query.get("token") ?? "";
const invite = query.get("invite") ?? "";

function report(result: object): void {
  console.log(`E2E_RESULT ${JSON.stringify(result)}`);
}

async function act(action: TeamsActionInput): Promise<TeamsView> {
  const result = await window.bee.teams.act({ ...action, sessionToken });
  if (result.error) throw new Error(`${action.type}: ${result.error}`);
  return result.view;
}

/** Tick every 200 ms until done() says so, collecting teammates' lines. */
async function tickUntil(done: (view: TeamsView) => boolean, lines: SessionLine[], timeoutMs = 20_000): Promise<TeamsView> {
  const started = Date.now();
  for (;;) {
    const result = await window.bee.teams.tick(sessionToken);
    lines.push(...result.lines);
    if (done(result.view)) return result.view;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out; last view ${JSON.stringify(result.view)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function run(): Promise<void> {
  const peerLines: SessionLine[] = [];
  const joinedTeam = await act({ type: "joinTeam", code: invite, displayName: "Alice" });
  await act({ type: "simulateMeeting", on: true });
  const prompted = await tickUntil((view) => view.prompt !== null, peerLines);
  const prompt = prompted.prompt;
  if (!prompt?.primary) throw new Error("no room to join in the popup");
  const joined = await act({ type: "joinSync", roomId: prompt.primary.roomId });

  const own: SessionLine = {
    id: "local-1",
    own: true,
    speakerId: joined.me?.userId ?? "local",
    speakerName: "Alice",
    text: "I will draft the SSO rollout plan by Monday.",
    clientTs: Date.now(),
    serverTs: null,
  };
  const sent = await window.bee.teams.publish({ text: own.text, clientTs: own.clientTs, source: "mic", sessionToken });
  await act({ type: "setShareMuted", muted: true });
  const mutedSent = await window.bee.teams.publish({ text: "Private aside while paused.", clientTs: Date.now(), source: "mic", sessionToken });
  await act({ type: "setShareMuted", muted: false });

  await tickUntil(() => peerLines.length > 0, peerLines);
  const lines = mergeLines([own], peerLines, 200);
  const summary = await window.bee.writeMeetingSummary({ transcript: summaryTranscript(lines, "Alice"), notesCited: [], tips: [], sessionToken });

  await act({ type: "simulateMeeting", on: false });
  const leftAt = Date.now();
  const left = await tickUntil((view) => view.room === null, peerLines);
  report({
    ok: true,
    team: joinedTeam.team?.name ?? null,
    prompt,
    members: joined.room?.members.map((member) => member.displayName) ?? [],
    sent: sent.sent,
    mutedSent: mutedSent.sent,
    peerLines: peerLines.map((line) => `${line.speakerName}: ${line.text}`),
    summary,
    leftAfterMs: Date.now() - leftAt,
    leftPrompt: left.prompt,
  });
}

run().catch((error) => report({ ok: false, error: String(error) }));
