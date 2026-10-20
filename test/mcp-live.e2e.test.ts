import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runHarnessWithOutput } from "./e2e/run";

// Live Electron E2E of Luna with the user's real MCP connectors (vmem and Eva): preload → main (meeting-ipc.ts) → Luna → MCP.
// Needs BEE_E2E_MCP_FILE (servers and tokens, see test/e2e/harness-main.ts) and BEE_AI_GATEWAY_API_KEY; skipped otherwise.

const QUESTIONS = [
  "What connectors do you have?",
  "How many tables are in Eva?",
  "Search my vmem memories for anything about Bee and tell me one thing you find.",
  "Use Eva's tool search to find which Eva tool lists database tables.",
];

const runSchema = z.object({
  question: z.string(),
  tips: z.array(z.string()),
  mcpErrors: z.array(z.object({ server: z.string(), error: z.string() })),
  guideError: z.string().nullable(),
  guideNote: z.string().nullable(),
  activity: z.array(z.string()),
});
const reportSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), runs: z.array(runSchema) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
const callSchema = z.object({ tool: z.string(), server: z.string(), ok: z.boolean(), chars: z.number(), preview: z.string() });
type McpCall = z.infer<typeof callSchema>;

const UPSTREAM = ["google drive", "notion", "gmail", "figma", "github"];
// Eva's data tools can fail server-side (e.g. a bad deploy key on Eva's side); then Luna must say so, not invent a count.
const HONEST_ERROR = /error|couldn|can't|cannot|unable|invalid|failed/i;
const TABLE_COUNT = /\b\d+\s+tables?\b/i;

const onServer = (server: string) => (call: McpCall) => call.server.toLowerCase() === server;

describe.skipIf(!process.env.BEE_E2E_MCP_FILE || !process.env.BEE_AI_GATEWAY_API_KEY)("Luna with live MCP connectors (Electron E2E)", () => {
  it("names Bee's connectors and calls Eva and vmem tools", { timeout: 320_000 }, async () => {
    const { report, lines } = await runHarnessWithOutput({
      page: "mcp-live-page",
      env: { BEE_E2E_QUESTIONS: JSON.stringify(QUESTIONS) },
      report: reportSchema,
      timeoutMs: 310_000,
    });
    if (!report.ok) throw new Error(`E2E failed: ${report.error}`);
    // Main prints an E2E_MARK line as each run starts; the E2E_MCP_CALL lines after it belong to that run.
    const perRun: McpCall[][] = [];
    for (const line of lines) {
      if (line.startsWith("E2E_MARK ")) perRun.push([]);
      else if (line.startsWith("E2E_MCP_CALL ")) perRun.at(-1)?.push(callSchema.parse(JSON.parse(line.slice("E2E_MCP_CALL ".length))));
    }
    report.runs.forEach((run, index) => {
      const tools = (perRun[index] ?? []).map((call) => `${call.server}:${call.tool}${call.ok ? "" : " (failed)"}`);
      console.log(`Q: ${run.question}\n  tools: ${tools.join(", ") || "none"}\n  tips: ${run.tips.join(" | ") || "none"}${run.guideError ? `\n  error: ${run.guideError}` : ""}`);
    });

    expect(report.runs).toHaveLength(QUESTIONS.length);
    expect(perRun).toHaveLength(QUESTIONS.length);
    for (const run of report.runs) expect(run.mcpErrors).toEqual([]);

    const [connectors, tables, memories] = report.runs;
    const said = (connectors?.tips ?? []).join(" ").toLowerCase();
    expect(said).toContain("vmem");
    expect(said).toContain("eva");
    expect(said).not.toContain("connected sources: none");
    // vmem's own upstream sources may be mentioned, but not reported as Bee's (dis)connected connectors.
    for (const name of UPSTREAM) expect(said).not.toMatch(new RegExp(`\\b${name}\\b[^.]*\\b(disconnected|not connected)`));

    const tableCalls = (perRun[1] ?? []).filter(onServer("eva"));
    expect(tableCalls.length).toBeGreaterThan(0);
    const tablesSaid = (tables?.tips ?? []).join(" ");
    const failedEva = tableCalls.filter((call) => !call.ok);
    if (failedEva.length > 0) console.warn(`Eva tools failed server-side (${failedEva.length}/${tableCalls.length}): ${failedEva[0]?.tool}: ${failedEva[0]?.preview}`);
    if (failedEva.length === tableCalls.length) {
      expect(tablesSaid).toMatch(HONEST_ERROR);
      expect(tablesSaid).not.toMatch(TABLE_COUNT);
    } else {
      expect(/\d/.test(tablesSaid) || HONEST_ERROR.test(tablesSaid)).toBe(true);
    }

    expect(perRun[2]?.some((call) => onServer("vmem")(call) && call.ok)).toBe(true);
    expect(memories?.guideError).toBeNull();

    // Expected: eva search_tools, which works even when Eva's data tools fail.
    expect(perRun[3]?.some((call) => onServer("eva")(call) && call.ok)).toBe(true);

    const allCalls = perRun.flat();
    expect(allCalls.some((call) => onServer("vmem")(call) && call.ok)).toBe(true);
    expect(allCalls.some((call) => onServer("eva")(call) && call.ok)).toBe(true);
  });
});
