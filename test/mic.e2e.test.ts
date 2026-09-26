import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { pipelineResultSchema } from "../src/shared/ipc";

// Electron E2E of the mic path with Chromium's fake audio device playing test/fixtures/sso-question.wav:
// Web Audio capture → segmenter → WAV → preload → main → live Grok STT → retrieve → Jev → Luna.
// Needs BEE_AI_GATEWAY_API_KEY and a built preload (npm run test:e2e builds it). Uses xvfb-run on Linux without a display.

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = `${root}out/e2e`;
const preload = `${root}out/preload/index.cjs`;

const reportSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    line: z.string(),
    sampleRate: z.number(),
    frames: z.number(),
    peakLevel: z.number(),
    pipeline: pipelineResultSchema,
  }),
  z.object({ ok: z.literal(false), stage: z.string(), error: z.string().optional() }),
]);

async function bundle(): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  // shared/clerk.ts reads a Vite env var; the fallback key is what production uses.
  const define = { "import.meta.env.VITE_CLERK_PUBLISHABLE_KEY": "undefined" };
  await build({
    entryPoints: [`${root}test/e2e/harness-main.ts`],
    outfile: `${outDir}/main.cjs`,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    define,
    logLevel: "error",
  });
  await build({
    entryPoints: [`${root}test/e2e/harness-page.ts`],
    outfile: `${outDir}/page.js`,
    bundle: true,
    platform: "browser",
    format: "iife",
    define,
    logLevel: "error",
  });
  writeFileSync(`${outDir}/page.html`, '<!doctype html><meta charset="utf-8"><script src="page.js"></script>\n');
}

describe("mic → Grok STT → pipeline (Electron E2E)", () => {
  it("turns fake-mic speech into a transcript line and tips, with no transcript UI", async () => {
    if (!process.env.BEE_AI_GATEWAY_API_KEY?.trim()) throw new Error("BEE_AI_GATEWAY_API_KEY is not set.");
    if (!existsSync(preload)) throw new Error("Build first: npm run test:e2e runs electron-vite build.");
    await bundle();
    const electron = z.string().parse(createRequire(import.meta.url)("electron"));
    const args = [`${outDir}/main.cjs`, ...(process.platform === "linux" ? ["--no-sandbox"] : [])];
    const headless = process.platform === "linux" && !process.env.DISPLAY;
    const run = spawnSync(headless ? "xvfb-run" : electron, headless ? ["-a", electron, ...args] : args, {
      encoding: "utf8",
      timeout: 90_000,
      env: {
        ...process.env,
        BEE_E2E_PRELOAD: preload,
        BEE_E2E_PAGE: `${outDir}/page.html`,
        BEE_E2E_AUDIO: `${root}test/fixtures/sso-question.wav`,
      },
    });
    const line = run.stdout.split("\n").find((text) => text.startsWith("E2E_RESULT "));
    if (!line) throw new Error(`No E2E result (exit ${run.status}).\n${run.stdout}\n${run.stderr}`);
    const report = reportSchema.parse(JSON.parse(line.slice("E2E_RESULT ".length)));
    console.log("E2E report:", JSON.stringify(report, null, 2));
    if (!report.ok) throw new Error(`E2E failed at ${report.stage}: ${report.error ?? ""}`);
    expect(report.peakLevel).toBeGreaterThan(0.01);
    expect(report.line).toMatch(/SSO ship/i);
    expect(report.pipeline.notes[0]?.title).toBe("Q4 product roadmap › Dates");
    expect(report.pipeline.rankSource).toBe("jev");
    expect(report.pipeline.tips.length).toBeGreaterThan(0);
  });
});
