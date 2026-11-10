// Checks that the built main bundle requires koffi at run time instead of inlining it.
// Usage: node scripts/check-koffi-external.mjs [out/main/index.js]
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const file = path.resolve(process.argv[2] ?? "out/main/index.js");
const MAX_BYTES = 5 * 1024 * 1024; // an inlined koffi would add its loader and tables on top of the app code

function fail(message) {
  console.error(`check-koffi-external: FAIL: ${message}`);
  process.exit(1);
}

let text;
try {
  text = readFileSync(file, "utf8");
} catch (error) {
  fail(`cannot read ${file}: ${error.message}`);
}
const match = text.match(/createRequire\([^)]*\)\(["']koffi["']\)/);
if (!match) fail(`${file} has no createRequire(...)("koffi") call`);
if (/Koffi (?:is|requires)|koffi\.node|@koromix\/koffi-/.test(text.replace(match[0], ""))) fail(`${file} appears to inline koffi internals`);
const size = statSync(file).size;
if (size > MAX_BYTES) fail(`${file} is ${size} bytes, over the ${MAX_BYTES} byte guard`);
console.log(`koffi stays external: ${match[0]} in ${file} (${size} bytes)`);
console.log("check-koffi-external: OK");
