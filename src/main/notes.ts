import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SEED_NOTES, chunkNotes, type NoteFile, type Snippet } from "../core/notes";
import { summaryFileName } from "../core/summary";

/** Create the notes folder and write the seed notes the first time it is empty. */
export function ensureNotesDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  if (readdirSync(dir).some((name) => name.toLowerCase().endsWith(".md"))) return;
  for (const note of SEED_NOTES) writeFileSync(join(dir, note.name), note.content);
}

/** Read every markdown note on each call, so edits show up without a restart. */
export function loadSnippets(dir: string): Snippet[] {
  const files: NoteFile[] = readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(".md"))
    .sort()
    .map((name) => ({ name, content: readFileSync(join(dir, name), "utf8") }));
  return chunkNotes(files);
}

/** Write a meeting summary as meeting-YYYY-MM-DD-HHmm.md (with -2, -3… if that minute is taken). Returns the absolute path. */
export function writeMeetingSummaryFile(dir: string, markdown: string, when = new Date()): string {
  mkdirSync(dir, { recursive: true });
  const base = summaryFileName(when).replace(/\.md$/, "");
  let path = join(dir, `${base}.md`);
  for (let n = 2; existsSync(path); n += 1) path = join(dir, `${base}-${n}.md`);
  writeFileSync(path, markdown, { flag: "wx" });
  return resolve(path);
}

/** True for a markdown file directly inside the notes folder, so the renderer cannot open arbitrary paths. */
export function isNotePath(dir: string, path: string): boolean {
  return dirname(resolve(path)) === resolve(dir) && path.toLowerCase().endsWith(".md");
}
