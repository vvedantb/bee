// Checks that koffi is unpacked from the asar in a packaged Windows app, and (on Windows) that AllowSetForegroundWindow binds.
// Usage: node scripts/check-koffi-windows.mjs [release/win-unpacked]
import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? "release/win-unpacked");
const unpacked = path.join(root, "resources", "app.asar.unpacked", "node_modules");
const koffiDir = path.join(unpacked, "koffi");
const binaryDir = path.join(unpacked, "@koromix", "koffi-win32-x64");
// Must match ASFW_SIGNATURE in src/main/foreground.ts.
const SIGNATURE = "bool __stdcall AllowSetForegroundWindow(uint32 dwProcessId)";

function fail(message) {
  console.error(`check-koffi-windows: FAIL: ${message}`);
  process.exit(1);
}

function findFile(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(full, name);
      if (hit) return hit;
    } else if (entry.name === name) return full;
  }
  return undefined;
}

const isDir = (p) => existsSync(p) && statSync(p).isDirectory();

if (!isDir(koffiDir)) fail(`koffi is not unpacked: missing directory ${koffiDir} (check build.asarUnpack)`);
if (!isDir(binaryDir)) fail(`win32-x64 package is not unpacked: missing directory ${binaryDir} (check build.asarUnpack)`);
const binary = findFile(binaryDir, "koffi.node");
if (!binary) fail(`koffi.node not found under ${binaryDir}`);
console.log(`koffi directory: ${koffiDir}`);
console.log(`koffi native binary: ${binary} (${statSync(binary).size} bytes)`);

if (process.platform !== "win32") {
  console.log(`Skipping AllowSetForegroundWindow bind: platform is ${process.platform}, not win32.`);
  console.log("check-koffi-windows: OK (files only)");
  process.exit(0);
}

try {
  const koffi = createRequire(path.join(koffiDir, "index.js"))(koffiDir);
  const fn = koffi.load("user32.dll").func(SIGNATURE);
  if (typeof fn !== "function") fail(`AllowSetForegroundWindow bound as ${typeof fn}, expected function`);
  console.log(`AllowSetForegroundWindow: bound (typeof ${typeof fn}); not called`);
} catch (error) {
  fail(`could not bind AllowSetForegroundWindow from the unpacked koffi: ${error instanceof Error ? error.message : error}`);
}
console.log("check-koffi-windows: OK");
