import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runHarness } from "./e2e/run";

// Electron E2E of a "Bee, …" request: preload → main (meeting-ipc.ts) → the Claude Agent SDK, which starts this machine's own
// Claude Code from Electron's main process, on its login. Needs Claude Code installed and signed in; no Gateway key is used.
// The signed-out case clears CLAUDE_CODE_OAUTH_TOKEN and points HOME at an empty folder, so no login is found.

const reportSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), ms: z.number(), tips: z.array(z.string()), guideError: z.string().nullable() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

async function ask(env: Record<string, string>) {
  const report = await runHarness({ page: "command-page", env: { BEE_AI_GATEWAY_API_KEY: "", ...env }, report: reportSchema });
  console.log("E2E report:", JSON.stringify(report));
  if (!report.ok) throw new Error(`E2E failed: ${report.error}`);
  return report;
}

describe("Bee, … on the user's Claude Code (Electron E2E)", () => {
  it("answers through the user's Claude Code, started from Electron's main process", async () => {
    const report = await ask({});
    expect(report.guideError).toBeNull();
    expect(report.tips.join(" ")).toMatch(/2,?700/);
  });

  it("says to sign in when Claude Code has no login", async () => {
    const report = await ask({ CLAUDE_CODE_OAUTH_TOKEN: "", HOME: mkdtempSync(join(tmpdir(), "bee-no-login-")) });
    expect(report.tips).toEqual([]);
    expect(report.guideError).toBe("Sign in to Claude Code to talk to Bee: run claude, then /login.");
  });
});
