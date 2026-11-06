// Runs in the sandboxed harness renderer: one "Bee, …" request through window.bee.runCommand, as the island sends it after the
// wake word. Main answers it on the Claude Agent SDK (core/claude-agent.ts). Reports once, via console, to harness-main.ts.

const sessionToken = new URLSearchParams(location.search).get("token") ?? "";

function report(result: object): void {
  console.log(`E2E_RESULT ${JSON.stringify(result)}`);
}

async function run(): Promise<void> {
  const started = performance.now();
  const result = await window.bee.runCommand({ command: "what's 15% of 18000?", runId: 1, sessionToken });
  report({ ok: true, ms: Math.round(performance.now() - started), tips: result.tips, guideError: result.guideError });
}

run().catch((error) => report({ ok: false, error: String(error) }));
export {};
