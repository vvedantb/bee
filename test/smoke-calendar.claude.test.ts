import { afterAll, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_CALENDAR_SYSTEM, agentCalendarPrompt, parseAgentCalendar } from "../src/core/agent-calendar";
import { createClaudeCode } from "../src/main/claude-code";

// Live: today's calendar through this machine's Claude Code (core/agent-calendar.ts), as main/index.ts asks for it. Whatever
// calendar tools the account has, the answer must be one Bee can read: events, or "none" without a calendar tool.

const claudeCode = createClaudeCode({ sessionDir: mkdtempSync(join(tmpdir(), "bee-claude-calendar-")) });
afterAll(() => claudeCode.close());

it("answers the calendar request in a form Bee can read", async () => {
  const found = await claudeCode.agent();
  if ("error" in found) throw new Error(found.error);
  const run = found.agent.background ?? found.agent;
  const now = new Date();
  const result = await run({ tier: "fast", system: AGENT_CALENDAR_SYSTEM, history: [], content: [agentCalendarPrompt(now)], tools: {}, maxTurns: 6, signal: AbortSignal.timeout(90_000) });
  console.log(`calendar answer: ${result.text.slice(0, 300)}`);
  expect(parseAgentCalendar(result.text)).not.toBeNull();
});
