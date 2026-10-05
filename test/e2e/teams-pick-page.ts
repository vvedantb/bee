// Runs in the sandboxed harness renderer as "Alice", with Bob's and Carol's syncs both live on the relay. Two Teams
// windows look like calls. First detection: dismiss the "Which meeting?" pick and check nothing joins. Second
// detection: pick "Call with Carol", join Carol's sync (not Bob's) and share one phrase. Reports once, via console.
import type { TeamsActionInput, TeamsView } from "../../src/shared/ipc";

const query = new URLSearchParams(location.search);
const sessionToken = query.get("token") ?? "";
const invite = query.get("invite") ?? "";
const MEETINGS = [{ title: "Meeting with Bob | Microsoft Teams" }, { title: "Call with Carol | Microsoft Teams" }];

function report(result: object): void {
  console.log(`E2E_RESULT ${JSON.stringify(result)}`);
}

async function act(action: TeamsActionInput): Promise<TeamsView> {
  const result = await window.bee.teams.act({ ...action, sessionToken });
  if (result.error) throw new Error(`${action.type}: ${result.error}`);
  return result.view;
}

/** Tick every 200 ms until done() says so. */
async function tickUntil(done: (view: TeamsView) => boolean, timeoutMs = 20_000): Promise<TeamsView> {
  const started = Date.now();
  for (;;) {
    const { view } = await window.bee.teams.tick(sessionToken);
    if (done(view)) return view;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out; last view ${JSON.stringify(view)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Ticks for a while and returns the last view, to check nothing happens on its own. */
async function idle(ms: number): Promise<TeamsView> {
  const started = Date.now();
  return tickUntil(() => Date.now() - started >= ms);
}

async function run(): Promise<void> {
  await act({ type: "joinTeam", code: invite, displayName: "Alice" });

  // Detection 1: two meeting windows, both syncs listed; dismiss.
  await act({ type: "simulateMeeting", on: true, meetings: MEETINGS });
  const first = await tickUntil((view) => (view.prompt?.others.length ?? 0) >= 2);
  const dismissed = await act({ type: "dismissPrompt" });
  const afterDismiss = await idle(1500);
  await act({ type: "simulateMeeting", on: false });
  await tickUntil((view) => !view.detection.inMeeting);

  // Detection 2: pick Carol's call, then her sync.
  await act({ type: "simulateMeeting", on: true, meetings: MEETINGS });
  const second = await tickUntil((view) => (view.prompt?.others.length ?? 0) >= 2 && view.prompt?.epoch !== first.prompt?.epoch);
  const carolCall = second.prompt?.meetings.find((meeting) => meeting.label === "Call with Carol");
  if (!carolCall) throw new Error("Carol's call is not in the pick");
  const picked = await act({ type: "selectMeeting", key: carolCall.key });
  const carolRoom = picked.prompt?.others.find((option) => option.label.startsWith("Carol"));
  if (!carolRoom) throw new Error("Carol's sync is not listed");
  const joined = await act({ type: "joinSync", roomId: carolRoom.roomId });
  const sent = await window.bee.teams.publish({ text: "Carol's call: budget review moves to Thursday.", clientTs: Date.now(), source: "mic", sessionToken });
  const settled = await idle(1500);

  report({
    ok: true,
    first: first.prompt,
    dismissedPrompt: dismissed.prompt,
    afterDismiss: { prompt: afterDismiss.prompt, room: afterDismiss.room?.id ?? null },
    second: second.prompt,
    picked: picked.prompt,
    joinedRoom: joined.room?.id ?? null,
    members: joined.room?.members.map((member) => member.displayName) ?? [],
    sent: sent.sent,
    settled: { prompt: settled.prompt, room: settled.room?.id ?? null },
  });
}

run().catch((error) => report({ ok: false, error: String(error) }));
