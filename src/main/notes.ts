import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SEED_NOTES, chunkNotes, type NoteFile, type Snippet } from "../core/notes";

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
