#!/usr/bin/env node
// Bans tests that read source files as text. Tests must import and call the code, not regex its source.
// Why not ESLint: the repo has no ESLint, and linting .ts would need eslint plus typescript-eslint (two more dev
// dependencies and a config) for one rule. This script has no dependencies and checks the same patterns.
//
// Flags, in *.test.ts, *.test.tsx and *.test.mjs files, a file read (readFile, readFileSync, readdir, readdirSync, open,
// createReadStream) whose arguments contain a string naming a source path or file type:
// .ts .tsx .css .html .cpp .swift, or a src/ or native/ directory. Also flags "?raw" imports.
// Fixtures, temp dirs, package.json, WAVs and PNGs are fine.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SKIP = new Set(["node_modules", "out", "release", "dist", ".git", "landing"]);
const TEST_FILE = /\.test\.(?:ts|tsx|mjs)$/;
const SELF_TEST = "no-source-text-in-tests.test.mjs"; // holds the bad patterns as sample strings
const READ_CALL = /\b(?:readFileSync|readFile|readdirSync|readdir|createReadStream|openSync|open)\s*\(/g;
const SOURCE_PATH = /\.(?:tsx?|css|html|cpp|swift)\b|(?:^|[\\/"'`(])(?:src|native)(?:[\\/]|["'`])/;
const MESSAGE = "Tests must import and call code, not read or regex source files. See the Testing section of CLAUDE.md.";

function* testFiles(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* testFiles(path);
    else if (TEST_FILE.test(name) && name !== SELF_TEST) yield path;
  }
}

/** Text between the parenthesis at `open` and its match, ignoring parentheses inside strings. */
function callArgs(text, open) {
  let depth = 0;
  let quote = "";
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

export function findViolations(text) {
  const found = [];
  for (const match of text.matchAll(READ_CALL)) {
    const args = callArgs(text, match.index + match[0].length - 1);
    if (SOURCE_PATH.test(args)) found.push({ line: lineOf(text, match.index), what: `${match[0].slice(0, -1).trim()}(${args.trim().slice(0, 60)})` });
  }
  for (const match of text.matchAll(/from\s+["'][^"']*\?raw["']|import\(\s*["'][^"']*\?raw["']/g)) found.push({ line: lineOf(text, match.index), what: match[0] });
  return found;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let failures = 0;
  for (const file of testFiles(ROOT)) {
    for (const { line, what } of findViolations(readFileSync(file, "utf8"))) {
      console.error(`${relative(ROOT, file)}:${line}: ${what}\n  ${MESSAGE}`);
      failures++;
    }
  }
  if (failures) process.exit(1);
  console.log("no-source-text-in-tests: ok");
}
