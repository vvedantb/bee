import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ModelMessage } from "ai";
import { compactMessages, parseHistory, type Summarise } from "../core/bee-history";
import { debugLog, errorData } from "../core/debug-log";

// Bee's history on disk (core/bee-history.ts): bee-history.json in the user data folder, next to the notes and logs folders. Main
// owns it: read once at start, sent whole with each direct request, and written after each request ends. Kept forever: no idle
// expiry and no turn cap. Only when it nears the model's window are the oldest messages folded into a summary.

export type BeeHistoryStore = {
  /** The history as it stands, oldest first. */
  messages: () => ModelMessage[];
  /** Adds one request's messages, compacts when needed, and writes the file. Calls run one at a time, in order. */
  append: (turn: readonly ModelMessage[], summarise?: Summarise) => Promise<void>;
};

const FILE_VERSION = 1;

export function createBeeHistoryStore(deps: { path: string }): BeeHistoryStore {
  let messages = read();
  let queue: Promise<void> = Promise.resolve();
  debugLog.info("history", "loaded", { path: deps.path, messages: messages.length });

  function read(): ModelMessage[] {
    try {
      return parseHistory(JSON.parse(readFileSync(deps.path, "utf8")));
    } catch (error) {
      // Missing on first run. Corrupt: start empty and keep the old file beside it, so nothing is lost.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        debugLog.warn("history", "read-failed", { error: errorData(error) });
        try {
          renameSync(deps.path, `${deps.path}.bad-${Date.now()}`);
        } catch {
          // Nothing to keep.
        }
      }
      return [];
    }
  }

  // Through a temp file and a rename, so a crash mid-write never leaves half a file.
  function write(): void {
    try {
      mkdirSync(dirname(deps.path), { recursive: true });
      const temp = `${deps.path}.tmp`;
      writeFileSync(temp, JSON.stringify({ version: FILE_VERSION, messages }), { mode: 0o600 });
      renameSync(temp, deps.path);
      try {
        chmodSync(deps.path, 0o600);
      } catch {
        // Windows has no chmod: the file stays in the user's own folder.
      }
    } catch (error) {
      debugLog.error("history", "write-failed", { error: errorData(error) });
    }
  }

  return {
    messages: () => [...messages],
    append: (turn, summarise) => {
      queue = queue.then(async () => {
        if (turn.length === 0) return;
        const next = parseHistory([...messages, ...turn]);
        const compacted = await compactMessages(next, { summarise });
        if (compacted !== next) debugLog.info("history", "compacted", { before: next.length, after: compacted.length });
        messages = compacted;
        write();
      });
      return queue.catch((error) => debugLog.error("history", "append-failed", { error: errorData(error) }));
    },
  };
}
