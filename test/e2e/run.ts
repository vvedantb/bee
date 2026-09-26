import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { z } from "zod";

// Shared by the Electron E2E tests: bundle harness-main.ts and one page, start Electron (xvfb-run on Linux without a
// display), and return the JSON the page reports as "E2E_RESULT {...}". Needs a built preload (npm run test:e2e).

export const root = fileURLToPath(new URL("../..", import.meta.url));
const outDir = `${root}out/e2e`;
const preload = `${root}out/preload/index.cjs`;

// Output names are per page, so E2E files running in parallel never write the same bundle.
async function bundle(page: string): Promise<{ main: string; html: string }> {
  mkdirSync(outDir, { recursive: true });
  // shared/clerk.ts reads a Vite env var; the fallback key is what production uses.
  const define = { "import.meta.env.VITE_CLERK_PUBLISHABLE_KEY": "undefined" };
  await build({
    entryPoints: [`${root}test/e2e/harness-main.ts`],
    outfile: `${outDir}/${page}-main.cjs`,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    define,
    logLevel: "error",
  });
  await build({
    entryPoints: [`${root}test/e2e/${page}.ts`],
    outfile: `${outDir}/${page}.js`,
    bundle: true,
    platform: "browser",
    format: "iife",
    define,
    logLevel: "error",
  });
  const html = `${outDir}/${page}.html`;
  writeFileSync(html, `<!doctype html><meta charset="utf-8"><script src="${page}.js"></script>\n`);
  return { main: `${outDir}/${page}-main.cjs`, html };
}

export async function runHarness<T extends z.ZodType>(args: { page: string; env: Record<string, string>; report: T }): Promise<z.infer<T>> {
  if (!existsSync(preload)) throw new Error("Build first: npm run test:e2e runs electron-vite build.");
  const { main, html } = await bundle(args.page);
  const electron = z.string().parse(createRequire(import.meta.url)("electron"));
  const electronArgs = [main, ...(process.platform === "linux" ? ["--no-sandbox"] : [])];
  const headless = process.platform === "linux" && !process.env.DISPLAY;
  const run = spawnSync(headless ? "xvfb-run" : electron, headless ? ["-a", electron, ...electronArgs] : electronArgs, {
    encoding: "utf8",
    timeout: 90_000,
    env: { ...process.env, ...args.env, BEE_E2E_PRELOAD: preload, BEE_E2E_PAGE: html },
  });
  const line = run.stdout.split("\n").find((text) => text.startsWith("E2E_RESULT "));
  if (!line) throw new Error(`No E2E result (exit ${run.status}).\n${run.stdout}\n${run.stderr}`);
  return args.report.parse(JSON.parse(line.slice("E2E_RESULT ".length)));
}
