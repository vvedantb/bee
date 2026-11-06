import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runHarness } from "./e2e/run";

// Electron E2E of a "Bee, …" request: preload → main (meeting-ipc.ts) → the Claude Agent SDK, which starts Claude Code from
// Electron's main process. The live case needs BEE_CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`); no Gateway key is used.

const reportSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), ms: z.number(), tips: z.array(z.string()), guideError: z.string().nullable() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

async function ask(token: string) {
  const report = await runHarness({ page: "command-page", env: { BEE_CLAUDE_CODE_OAUTH_TOKEN: token, BEE_AI_GATEWAY_API_KEY: "" }, report: reportSchema });
  console.log("E2E report:", JSON.stringify(report));
  if (!report.ok) throw new Error(`E2E failed: ${report.error}`);
  return report;
}

describe("Bee, … on the user's Claude account (Electron E2E)", () => {
  it("answers through Claude Code started from Electron's main process", async () => {
    const token = process.env.BEE_CLAUDE_CODE_OAUTH_TOKEN?.trim();
    if (!token) throw new Error("BEE_CLAUDE_CODE_OAUTH_TOKEN is not set.");
    const report = await ask(token);
    expect(report.guideError).toBeNull();
    expect(report.tips.join(" ")).toMatch(/2,?700/);
  });

  it("says a Claude token is needed without one", async () => {
    const report = await ask("");
    expect(report.tips).toEqual([]);
    expect(report.guideError).toBe("No Claude token. Add one in Settings.");
  });
});
