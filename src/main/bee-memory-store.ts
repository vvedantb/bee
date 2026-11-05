import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_FILE_VERSION, applyMemoryChange, parseMemoryFacts, type BeeMemory, type MemoryFact } from "../core/bee-memory";
import { debugLog, errorData } from "../core/debug-log";

// Bee's memory on disk (core/bee-memory.ts): facts.json in the memory folder inside the user data folder, next to bee-history.json.
// Read once at start and kept in main; each change is written at once, through a temp file and a rename. A missing folder or file
// is an empty memory; a corrupt file is kept beside the new one (facts.json.bad-<time>) and Bee starts empty.

export const MEMORY_DIR = "memory";
export const FACTS_FILE = "facts.json";

export type BeeMemoryStore = BeeMemory & { path: string };

export function createBeeMemoryStore(deps: { userDataDir: string; now?: () => Date }): BeeMemoryStore {
  const dir = join(deps.userDataDir, MEMORY_DIR);
  const path = join(dir, FACTS_FILE);
  const now = deps.now ?? (() => new Date());
  let facts = read();
  debugLog.info("memory", "loaded", { path, facts: facts.length });

  function read(): MemoryFact[] {
    try {
      return parseMemoryFacts(JSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        debugLog.warn("memory", "read-failed", { error: errorData(error) });
        try {
          renameSync(path, `${path}.bad-${Date.now()}`);
        } catch {
          // Nothing to keep.
        }
      }
      return [];
    }
  }

  function write(next: readonly MemoryFact[]): boolean {
    try {
      mkdirSync(dir, { recursive: true });
      const temp = `${path}.tmp`;
      writeFileSync(temp, JSON.stringify({ version: MEMORY_FILE_VERSION, facts: next }, null, 1), { mode: 0o600 });
      renameSync(temp, path);
      try {
        chmodSync(path, 0o600);
      } catch {
        // Windows has no chmod: the file stays in the user's own folder.
      }
      return true;
    } catch (error) {
      debugLog.error("memory", "write-failed", { error: errorData(error) });
      return false;
    }
  }

  return {
    path,
    facts: () => [...facts],
    write: (change) => {
      const result = applyMemoryChange(facts, change, now());
      if (!result.ok) {
        debugLog.info("memory", "write-refused", { message: result.message });
        return result;
      }
      if (!write(result.facts)) return { ok: false, message: "Error: Bee could not save its memory on this computer.", facts: [...facts] };
      facts = result.facts;
      debugLog.info("memory", "written", { message: result.message, facts: facts.length });
      return result;
    },
  };
}
