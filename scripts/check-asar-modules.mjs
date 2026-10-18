// Fails if a package that the built app imports at runtime is missing from app.asar.
import { listPackage } from "@electron/asar";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_ASARS = [
  "release/mac-arm64/Bee.app/Contents/Resources/app.asar",
  "release/mac/Bee.app/Contents/Resources/app.asar",
];
// Optional peers that a dependency loads but the bundles never name.
// The renderer is fully bundled, so only main and preload are scanned.
const EXTRA_PACKAGES = ["electron-store"];
const PROVIDED = new Set(["electron", ...builtinModules]);

/** Maps an import specifier to its package name, or null if the runtime provides it. */
export function packageName(specifier) {
  if (specifier.startsWith("node:") || specifier.startsWith(".") || specifier.startsWith("/")) return null;
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  return PROVIDED.has(name) || PROVIDED.has(specifier) ? null : name;
}

/** Finds bare import and require specifiers in built JavaScript. */
export function findSpecifiers(source) {
  const found = new Set();
  // A specifier never holds spaces or commas, so text such as ["the", "from", "will"] in a bundled word list is not an import.
  const patterns = [/\bfrom\s*["']([^"'\s,]+)["']/g, /\bimport\s*["']([^"'\s,]+)["']/g, /\b(?:require|import)\(\s*["']([^"'\s,]+)["']\s*\)/g];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) found.add(match[1]);
  return found;
}

function jsFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.(c|m)?js$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

function requiredPackages(outDir) {
  const required = new Set(EXTRA_PACKAGES);
  for (const dir of ["main", "preload"]) {
    for (const file of jsFiles(join(outDir, dir))) {
      for (const specifier of findSpecifiers(readFileSync(file, "utf8"))) {
        const name = packageName(specifier);
        if (name) required.add(name);
      }
    }
  }
  return [...required].sort();
}

function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const asar = process.argv[2] || process.env.ASAR || DEFAULT_ASARS.map((path) => join(root, path)).find(existsSync);
  if (!asar || !existsSync(asar)) {
    console.error(`app.asar not found (tried ${asar ?? DEFAULT_ASARS.join(", ")}). Pass a path or set ASAR.`);
    process.exit(1);
  }
  const entries = new Set(listPackage(asar).map((entry) => entry.replaceAll("\\", "/").replace(/^\//, "")));
  const required = requiredPackages(join(root, "out"));
  const missing = required.filter((name) => !entries.has(`node_modules/${name}/package.json`));
  console.log(`Checked ${required.length} packages in ${asar}: ${required.join(", ")}`);
  if (missing.length) {
    console.error(`Missing from app.asar: ${missing.join(", ")}`);
    process.exit(1);
  }
  console.log("check-asar-modules: OK");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
