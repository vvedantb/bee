// Runs in the sandboxed harness renderer: a few meeting lines → window.bee.runPipeline, then
// window.bee.writeMeetingSummary with the notes cited and tips (as store.ts endMeeting does), then one more pipeline
// run that should retrieve the new summary. Reports once, via console, to harness-main.ts.

const sessionToken = new URLSearchParams(location.search).get("token") ?? "";

const LINES = [
  "Let's pick up the Acme renewal. They are asking for a bigger discount.",
  "We agreed to hold the discount at 10% and not go to 15% without finance.",
  "Priya will send the renewal quote and the support SLA summary by Friday.",
];

function report(result: object): void {
  console.log(`E2E_RESULT ${JSON.stringify(result)}`);
}

async function run(): Promise<void> {
  const pipeline = await window.bee.runPipeline({ transcript: LINES, sessionToken });
  const notesCited = pipeline.notes.filter((note) => note.cite !== null).map((note) => note.title);
  const summary = await window.bee.writeMeetingSummary({ transcript: LINES, notesCited, tips: pipeline.tips, sessionToken });
  const recall = await window.bee.runPipeline({ transcript: ["Last time, what did Priya agree to send for Acme?"], sessionToken });
  report({ ok: true, notesCited, summary, recalled: recall.notes.map((note) => note.title) });
}

run().catch((error) => report({ ok: false, error: String(error) }));
