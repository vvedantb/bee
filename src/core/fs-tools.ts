import { tool } from "ai";
import { appendFileSync, lstatSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { z } from "zod";
import { FS_LIMITS, hasBinaryExtension, isInside, looksBinary, resolveInRoots } from "./fs-sandbox";

export type FsRoots = { notesDir: string; extraRoots?: readonly string[] };

function rootsOf(roots: FsRoots): string[] {
  const notes = resolve(roots.notesDir);
  return [notes, ...(roots.extraRoots ?? []).map((root) => resolve(root)).filter((root) => root !== notes)];
}

/** Path shown to Luna: relative to the notes folder (with "/"), or absolute for an extra folder. */
function display(roots: readonly string[], path: string): string {
  const base = roots[0] as string;
  if (!isInside(base, path)) return path;
  return relative(base, path).split("\\").join("/") || ".";
}

function isHidden(name: string): boolean {
  return name.startsWith(".");
}

function fileSize(path: string): number | null {
  try {
    const stat = lstatSync(path);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

/** Why a file cannot be read as text, or null when it can. */
function unreadable(path: string): string | null {
  const size = fileSize(path);
  if (size === null) return "Not a file.";
  if (hasBinaryExtension(path) || looksBinary(path)) return "Binary file skipped.";
  if (size > FS_LIMITS.maxFileBytes) return `File is larger than ${FS_LIMITS.maxFileBytes / 1024} KiB.`;
  return null;
}

export function listDir(roots: FsRoots, input: { path?: string; recursive?: boolean }): string {
  const all = rootsOf(roots);
  const resolved = resolveInRoots(all, input.path);
  if (!resolved.ok) return `Error: ${resolved.error}`;
  const lines: string[] = [];
  let truncated = false;

  function walk(dir: string, depth: number): boolean {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return true;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (isHidden(entry.name) || entry.isSymbolicLink()) continue;
      if (lines.length >= FS_LIMITS.maxListEntries) {
        truncated = true;
        return false;
      }
      const path = join(dir, entry.name);
      const shown = display(all, path);
      if (entry.isDirectory()) {
        lines.push(`dir  ${shown}/`);
        if (input.recursive && depth < 1 && !walk(path, depth + 1)) return false;
      } else if (entry.isFile()) {
        const size = fileSize(path) ?? 0;
        lines.push(hasBinaryExtension(entry.name) ? `skip ${shown} (binary)` : `file ${shown} (${size} bytes)`);
      }
    }
    return true;
  }

  try {
    if (!lstatSync(resolved.path).isDirectory()) return "Error: Not a directory.";
  } catch {
    return "Error: Folder not found.";
  }
  walk(resolved.path, 0);
  if (lines.length === 0) return "(empty)";
  return lines.join("\n") + (truncated ? `\n(list cut at ${FS_LIMITS.maxListEntries} entries)` : "");
}

export function readFile(roots: FsRoots, input: { path: string }): string {
  const resolved = resolveInRoots(rootsOf(roots), input.path);
  if (!resolved.ok) return `Error: ${resolved.error}`;
  const problem = unreadable(resolved.path);
  if (problem) return `Error: ${problem}`;
  try {
    const text = readFileSync(resolved.path, "utf8");
    if (text.length <= FS_LIMITS.maxReadChars) return text;
    return `${text.slice(0, FS_LIMITS.maxReadChars)}\n(truncated at ${FS_LIMITS.maxReadChars} characters)`;
  } catch {
    return "Error: Could not read the file.";
  }
}

function snippetAround(line: string, index: number): string {
  const max = FS_LIMITS.maxSnippetChars;
  const start = Math.max(0, index - Math.floor(max / 4));
  const piece = line.slice(start, start + max).trim();
  return `${start > 0 ? "…" : ""}${piece}${start + max < line.length ? "…" : ""}`;
}

export function searchFiles(roots: FsRoots, input: { query: string; path?: string }): string {
  const all = rootsOf(roots);
  const query = input.query.trim().toLowerCase();
  if (query === "") return "Error: Query is empty.";
  // No path: search every root. With a path: only that folder.
  const starts: string[] = [];
  if (input.path === undefined) starts.push(...all);
  else {
    const resolved = resolveInRoots(all, input.path);
    if (!resolved.ok) return `Error: ${resolved.error}`;
    starts.push(resolved.path);
  }

  const hits: string[] = [];
  let visited = 0;

  function walk(dir: string, depth: number): void {
    if (hits.length >= FS_LIMITS.maxSearchHits || depth > FS_LIMITS.maxWalkDepth) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (hits.length >= FS_LIMITS.maxSearchHits || visited >= FS_LIMITS.maxWalkFiles) return;
      if (isHidden(entry.name) || entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile() || hasBinaryExtension(entry.name)) continue;
      visited += 1;
      const shown = display(all, path);
      const nameHit = entry.name.toLowerCase().includes(query);
      if (unreadable(path) !== null) {
        if (nameHit) hits.push(`${shown}: name match`);
        continue;
      }
      let match: string | null = null;
      try {
        for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
          const index = line.toLowerCase().indexOf(query);
          if (index !== -1) {
            match = snippetAround(line, index);
            break;
          }
        }
      } catch {
        // Unreadable file: treat as no content match.
      }
      if (match !== null) hits.push(`${shown}: ${match}`);
      else if (nameHit) hits.push(`${shown}: name match`);
    }
  }

  for (const start of starts) walk(start, 0);
  if (hits.length === 0) return "No matches.";
  return hits.join("\n") + (hits.length >= FS_LIMITS.maxSearchHits ? `\n(stopped at ${FS_LIMITS.maxSearchHits} hits)` : "");
}

/** Create or append to a .md file directly in the notes folder. Never overwrites, never leaves the folder. */
export function appendNote(roots: FsRoots, input: { name: string; text: string }): string {
  const name = input.name.trim().replace(/\\/g, "/");
  if (name === "" || name.includes("\0")) return "Error: Name is not valid.";
  if (name !== basename(name) || name === "." || name === ".." || isHidden(name)) {
    return "Error: Use a file name only, with no folders.";
  }
  if (extname(name).toLowerCase() !== ".md") return "Error: Only .md files can be written.";
  if (input.text.trim() === "") return "Error: Text is empty.";
  if (input.text.length > FS_LIMITS.maxAppendChars) return `Error: Text is longer than ${FS_LIMITS.maxAppendChars} characters.`;

  const notes = resolve(roots.notesDir);
  const resolved = resolveInRoots([notes], name);
  if (!resolved.ok) return `Error: ${resolved.error}`;
  let prefix = "";
  try {
    const stat = lstatSync(resolved.path);
    if (!stat.isFile()) return "Error: Not a file.";
    if (stat.size + input.text.length > FS_LIMITS.maxFileBytes) return "Error: Note would be too large.";
    if (stat.size > 0 && !readFileSync(resolved.path, "utf8").endsWith("\n")) prefix = "\n";
  } catch {
    // New file.
  }
  try {
    appendFileSync(resolved.path, `${prefix}${input.text.endsWith("\n") ? input.text : `${input.text}\n`}`);
  } catch {
    return "Error: Could not write the note.";
  }
  return `Saved to ${name}.`;
}

/** Luna's file tools. Reads span the notes folder and approved extra folders; writes reach only the notes folder. */
export function fsTools(roots: FsRoots) {
  return {
    list_dir: tool({
      description: "List files and folders in the user's local notes. Defaults to the notes folder. Returns names, type and size.",
      inputSchema: z.object({
        path: z.string().optional().describe("Folder, relative to the notes folder, or absolute inside an approved folder. Default: the notes folder."),
        recursive: z.boolean().optional().describe("Also list one level of subfolders."),
      }),
      execute: async (input) => listDir(roots, input),
    }),
    search_files: tool({
      description: "Search the user's local notes by file name or text content, case-insensitive. Returns paths with a short matching line.",
      inputSchema: z.object({
        query: z.string().describe("Text to find in file names or file contents."),
        path: z.string().optional().describe("Limit the search to this folder. Default: all approved folders."),
      }),
      execute: async (input) => searchFiles(roots, input),
    }),
    read_file: tool({
      description: "Read one text file from the user's local notes. Large or binary files are refused.",
      inputSchema: z.object({ path: z.string().describe("File path as returned by list_dir or search_files.") }),
      execute: async (input) => readFile(roots, input),
    }),
    append_note: tool({
      description:
        "Create a .md note in the notes folder, or append to an existing one. Use only when the user clearly asks to add or save a note. Never overwrites.",
      inputSchema: z.object({
        name: z.string().describe("File name ending in .md, with no folders, for example ideas.md."),
        text: z.string().describe("Markdown to append."),
      }),
      execute: async (input) => appendNote(roots, input),
    }),
  };
}
