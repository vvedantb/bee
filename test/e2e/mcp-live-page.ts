// Runs in the sandboxed harness renderer for the live MCP test: no mic. One window.bee.runPipeline per question, in order,
// with the tools Luna used in each run. Questions come from ?questions= (a JSON array), else the fixed list. An E2E_MARK
// line before each run lets the test split the E2E_MCP_CALL lines. Reports once.
import type { PipelineResult } from "../../src/shared/ipc";

type Run = Pick<PipelineResult, "tips" | "guideError"> & { question: string; mcpErrors: NonNullable<PipelineResult["mcpErrors"]>; guideNote: string | null; activity: string[] };

const params = new URLSearchParams(location.search);
const sessionToken = params.get("token") ?? "";

const QUESTIONS = [
  "What connectors do you have?",
  "How many tables are in Eva?",
  "Search my vmem memories for anything about Bee and tell me one thing you find.",
  "Use Eva's tool search to find which Eva tool lists database tables.",
];

function questions(): string[] {
  try {
    const parsed: unknown = JSON.parse(params.get("questions") || "null");
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((item) => typeof item === "string")) return parsed;
  } catch {
    // Not JSON: use the fixed list.
  }
  return QUESTIONS;
}

function report(result: object): void {
  console.log(`E2E_RESULT ${JSON.stringify(result)}`);
}

async function run(): Promise<void> {
  const runs: Run[] = [];
  for (const [index, question] of questions().entries()) {
    console.log(`E2E_MARK ${JSON.stringify({ run: index })}`);
    const activity: string[] = [];
    const stop = window.bee.onLunaActivity((tool) => activity.push(tool));
    try {
      const result = await window.bee.runPipeline({ transcript: [question], sessionToken });
      runs.push({ question, tips: result.tips, mcpErrors: result.mcpErrors ?? [], guideError: result.guideError, guideNote: result.guideNote ?? null, activity });
    } finally {
      stop();
    }
  }
  report({ ok: true, runs });
}

run().catch((error) => report({ ok: false, error: String(error) }));
