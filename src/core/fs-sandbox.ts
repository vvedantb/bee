import { closeSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";

export const FS_LIMITS = {
  maxFileBytes: 256 * 1024,
  maxReadChars: 64 * 1024,
  maxListEntries: 200,
  maxSearchHits: 20,
  maxSnippetChars: 200,
  maxAppendChars: 8 * 1024,
  maxWalkFiles: 2000,
  maxWalkDepth: 4,
  sniffBytes: 4096,
} as const;

const BINARY_EXTENSIONS = new Set([
  ".exe", ".dll", ".so", ".dylib", ".bin", ".node", ".wasm", ".obj", ".o", ".class", ".jar", ".msi", ".dmg",
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".heic", ".tif", ".tiff",
  ".pdf", ".zip", ".gz", ".tar", ".7z", ".rar", ".bz2", ".xz",
  ".mp3", ".wav", ".m4a", ".flac", ".ogg", ".mp4", ".mov", ".avi", ".mkv", ".webm",
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".sqlite", ".db", ".woff", ".woff2", ".ttf", ".otf",
]);

export function hasBinaryExtension(name: string): boolean {
  return BINARY_EXTENSIONS.has(extname(name).toLowerCase());
}

/** True when the first bytes of the file contain NUL. Unreadable files count as binary. */
export function looksBinary(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(FS_LIMITS.sniffBytes);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).includes(0);
  } catch {
    return true;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Parse the Settings textarea or a saved list: trim, drop empties and duplicates, require absolute paths. */
export function normalizeFsRoots(input: readonly string[]): { roots: string[]; invalid: string[] } {
  const roots: string[] = [];
  const invalid: string[] = [];
  for (const raw of input) {
    const value = raw.trim();
    if (value === "") continue;
    if (value.includes("\0") || !isAbsolute(value)) {
      invalid.push(value);
      continue;
    }
    const path = resolve(value);
    if (!roots.includes(path)) roots.push(path);
  }
  return { roots, invalid };
}

export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

/** Real path of the nearest existing ancestor (or the path itself). */
function realNearest(path: string): string | null {
  let current = path;
  for (;;) {
    const real = realpathOrNull(current);
    if (real !== null) return real;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export type Resolved = { ok: true; path: string; root: string } | { ok: false; error: string };

/**
 * Resolve a user path against the allowed roots. Roots[0] is the notes folder; relative paths start there.
 * Backslashes count as separators on every platform, so `..\x` cannot slip through on macOS or Linux.
 * Symlinks are refused: the target and its ancestors must resolve inside the same root.
 */
export function resolveInRoots(roots: readonly string[], input: string | undefined): Resolved {
  const raw = (input ?? ".").trim();
  if (raw === "") return { ok: false, error: "Path is empty." };
  if (raw.includes("\0")) return { ok: false, error: "Path is not valid." };
  const normalised = raw.replace(/\\/g, "/");
  const base = roots[0];
  if (base === undefined) return { ok: false, error: "No folders are available." };
  const target = resolve(base, normalised);
  const root = roots.find((candidate) => isInside(candidate, target));
  if (root === undefined) return { ok: false, error: "Path is outside the folders the AI may use." };

  const realRoot = realpathOrNull(root);
  const realTarget = realNearest(target);
  if (realRoot === null || realTarget === null || !isInside(realRoot, realTarget)) {
    return { ok: false, error: "Path is outside the folders the AI may use." };
  }
  try {
    if (lstatSync(target).isSymbolicLink()) return { ok: false, error: "Symbolic links are not followed." };
  } catch {
    // Missing path: the caller reports it.
  }
  return { ok: true, path: target, root };
}
