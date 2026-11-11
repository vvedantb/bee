// Runs in the harness renderer for the scenario lab (test/scenarios.lab.test.ts): one "Bee, …" request, as the island sends it,
// with every Confirm prompt answered Confirm (as a user who agrees would). Reports the reply, the steps shown and the prompts asked.

const query = new URLSearchParams(location.search);
const sessionToken = query.get("token") ?? "";
const command = query.get("questions") ?? "";
const steps: string[] = [];
const confirms: { kind: string; question: string; detail: string }[] = [];

window.bee.computer.onUpdate((update) => {
  if (update.type === "step") steps.push(update.label);
  if (update.type !== "confirm") return;
  confirms.push({ kind: update.kind, question: update.question, detail: update.detail });
  void window.bee.computer.answer({ runId: update.runId, id: update.id, confirmed: true });
});

async function run(): Promise<void> {
  const started = performance.now();
  const result = await window.bee.runCommand({ command, runId: 1, sessionToken });
  console.log(`E2E_RESULT ${JSON.stringify({ ok: true, ms: Math.round(performance.now() - started), tips: result.tips, guideError: result.guideError, steps, confirms })}`);
}

run().catch((error) => console.log(`E2E_RESULT ${JSON.stringify({ ok: false, error: String(error) })}`));
export {};
