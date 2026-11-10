// Runs a built call audio helper with --protocol and compares its JSON with the exports of src/core/teams-audio-protocol.ts.
// Usage: node scripts/check-helper-protocol.mjs <helper-path>. Platform comes from process.platform (win32 or darwin), or BEE_HELPER_PROTOCOL_PLATFORM.
// The TypeScript module is bundled with esbuild to a temp file and imported, so the real values are compared.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

// BEE_HELPER_PROTOCOL_PLATFORM=win32|darwin overrides process.platform, so a fake helper can be checked on Linux.
const platform = process.env.BEE_HELPER_PROTOCOL_PLATFORM || process.platform;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Expected `--protocol` fields for a platform, from the TypeScript exports. */
export function expectedFor(platform, ts) {
  const base = { protocol: ts.TEAMS_AUDIO_PROTOCOL, sampleRate: ts.HELPER_SAMPLE_RATE, exit: { ...ts.HELPER_EXIT } };
  if (platform === "win32") {
    return {
      ...base,
      teamsImages: [...ts.TEAMS_WINDOWS_IMAGES],
      // The --image allowlist: Teams, Zoom and the Meet browsers.
      targetImages: [...ts.CALL_AUDIO_WINDOWS_IMAGES],
      // Windows API constants: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK and PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE.
      capture: { activationTypeProcessLoopback: 1, loopbackIncludeTargetProcessTree: 0, processLoopbackDevice: "VAD\\Process_Loopback" },
    };
  }
  if (platform === "darwin") {
    return {
      ...base,
      teamsBundleIds: [...ts.TEAMS_MAC_BUNDLE_IDS],
      // The --bundle-id allowlist: Teams, Zoom and the Meet browsers.
      targetBundleIds: [...ts.CALL_AUDIO_MAC_BUNDLE_IDS],
      beeBundleId: ts.BEE_BUNDLE_ID,
      capture: { contentFilter: "including-apps", excludesBee: true },
    };
  }
  throw new Error(`No helper on platform ${platform}`);
}

/** Field-by-field differences, as "path: expected X, got Y" lines. Only expected fields are compared. */
export function diff(expected, actual, path = "") {
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object") return [`${path || "(root)"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
    if (Array.isArray(expected)) {
      return JSON.stringify(expected) === JSON.stringify(actual) ? [] : [`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
    }
    return Object.keys(expected).flatMap((key) => diff(expected[key], actual[key], path ? `${path}.${key}` : key));
  }
  return expected === actual ? [] : [`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
}

function loadProtocolModule(dir) {
  const outfile = join(dir, "teams-audio-protocol.mjs");
  buildSync({ entryPoints: [join(root, "src/core/teams-audio-protocol.ts")], bundle: true, format: "esm", platform: "node", outfile, logLevel: "error" });
  return import(pathToFileURL(outfile).href);
}

async function main() {
  const helper = process.argv[2];
  if (!helper) {
    console.error("Usage: node scripts/check-helper-protocol.mjs <helper-path>");
    return 2;
  }
  const run = spawnSync(resolve(helper), ["--protocol"], { encoding: "utf8", timeout: 30_000 });
  if (run.error || run.status !== 0) {
    console.error(`Helper --protocol failed (status ${run.status}): ${run.error?.message ?? run.stderr}`);
    return 1;
  }
  let actual;
  try {
    actual = JSON.parse(run.stdout);
  } catch (error) {
    console.error(`Helper --protocol did not print one JSON object: ${error.message}\n${run.stdout}`);
    return 1;
  }
  const dir = mkdtempSync(join(tmpdir(), "bee-helper-protocol-"));
  try {
    const ts = await loadProtocolModule(dir);
    const problems = diff(expectedFor(platform, ts), actual);
    if (problems.length > 0) {
      console.error(`Helper protocol differs from src/core/teams-audio-protocol.ts:\n${problems.map((line) => `  ${line}`).join("\n")}`);
      return 1;
    }
    console.log(`Helper protocol matches (${platform}, protocol ${ts.TEAMS_AUDIO_PROTOCOL}).`);
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function isMain() {
  if (!process.argv[1]) return false;
  const a = resolve(process.argv[1]);
  const b = resolve(fileURLToPath(import.meta.url));
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

if (isMain()) process.exit(await main());
