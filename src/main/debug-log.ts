import { mkdirSync, openSync, writeSync } from "node:fs";
import { access, mkdir, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { DebugEvent, DebugLevel, DebugSink } from "../core/debug-log";
import { redactDebugData } from "../core/debug-redact";
import type { SettingsUpdate, SettingsView } from "../shared/ipc";

// Bee's local debug log: JSON Lines under <userData>/logs, beside the notes folder. One file per session, named for when it
// started; a new file starts when the day changes or the current one passes maxFileBytes. Bee never deletes, prunes or
// overwrites a log file: every old file stays where it is (files open with "ax", append and never replace). Nothing here
// uploads anything.
//
// Writing is batched and asynchronous: write() only redacts, serialises and queues the line. A timer (or a full queue) writes
// the batch with one async call, so no event waits on the disk. At exit, flushSync() writes what is left in one go.

/** Where an event came from. */
export type DebugSource = "main" | "renderer";

/** One event as written to the file, one per line. */
export type DebugLine = {
  ts: string;
  seq: number;
  session: string;
  src: DebugSource;
  level: DebugLevel;
  category: string;
  event: string;
  data?: unknown;
};

export type DebugLogWriter = DebugSink & {
  readonly dir: string;
  readonly sessionId: string;
  /** Queues one event, whatever its level (wants() is the caller's filter). ts: when it happened, ms since the epoch. */
  write: (event: DebugEvent & { ts?: number; src?: DebugSource }) => void;
  /** Settings → Verbose debug logs. Off keeps warnings and errors only. Applies at once. */
  setVerbose: (verbose: boolean) => void;
  verbose: () => boolean;
  /** The file being written, or null before the first write. */
  file: () => string | null;
  /** Writes everything queued so far. */
  flush: () => Promise<void>;
  /** At exit only: writes what is still queued with one synchronous call. */
  flushSync: () => void;
  /** Flushes, closes the file and ignores later writes. */
  close: () => Promise<void>;
};

/** A new file once the current one passes this. Old files are kept, never removed. */
export const DEBUG_LOG_MAX_FILE_BYTES = 64 * 1024 * 1024;
/** How long an event may wait in the queue. */
export const DEBUG_LOG_FLUSH_MS = 1000;
/** A queue this big is written at once, without waiting for the timer. */
const FLUSH_BYTES = 256 * 1024;
/** One event past this keeps its names and a preview only, so a runaway payload cannot fill the disk. */
export const DEBUG_LOG_MAX_LINE_BYTES = 1024 * 1024;
const PREVIEW_CHARS = 16 * 1024;
/** While writes keep failing (disk full, folder gone), the queue keeps at most this much; older unwritten events go. */
const MAX_QUEUE_BYTES = 16 * 1024 * 1024;
/** After a failed write, the next try waits this long. */
const RETRY_MS = 30_000;
/** Failed writes in a row before the file is given up for a new one (a handle that will never work again). */
const FAILURES_BEFORE_NEW_FILE = 3;

type Queued = { text: string; bytes: number };

const pad = (value: number, width = 2) => String(value).padStart(width, "0");
/** Local date, for the file name and the daily split. */
const localDay = (when: Date) => `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
const localTime = (when: Date) => `${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`;

/** bee-YYYY-MM-DD-HHmmss-<session>.jsonl, local time; -2, -3… if that name is taken. */
export function debugLogFileName(when: Date, sessionId: string, attempt = 1): string {
  const short = sessionId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "session";
  return `bee-${localDay(when)}-${localTime(when)}-${short}${attempt > 1 ? `-${attempt}` : ""}.jsonl`;
}

export function createDebugLog(options: {
  dir: string;
  sessionId: string;
  verbose?: boolean;
  maxFileBytes?: number;
  maxLineBytes?: number;
  flushMs?: number;
  /** The clock, for tests. */
  now?: () => Date;
  /** Written as the first line of every file, so each file says which app and session it belongs to. */
  header?: () => Record<string, unknown>;
  /** A write failed. Called once until a write succeeds again, so it may log without looping. */
  onError?: (error: unknown) => void;
}): DebugLogWriter {
  const { dir, sessionId } = options;
  const maxFileBytes = options.maxFileBytes ?? DEBUG_LOG_MAX_FILE_BYTES;
  const maxLineBytes = options.maxLineBytes ?? DEBUG_LOG_MAX_LINE_BYTES;
  const flushMs = options.flushMs ?? DEBUG_LOG_FLUSH_MS;
  const now = options.now ?? (() => new Date());
  let verbose = options.verbose ?? true;
  let seq = 0;
  let queue: Queued[] = [];
  let queuedBytes = 0;
  let dropped = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();
  let closed = false;
  let failing = false;
  let failures = 0;
  let retryAt = 0;
  // The file being written: its handle (async writes) or fd (after flushSync), path, size and day.
  let handle: FileHandle | null = null;
  let fd: number | null = null;
  let path: string | null = null;
  let bytes = 0;
  // Events in the current file, so one event bigger than the cap still gets a file of its own instead of rolling forever.
  let fileEvents = 0;
  let day = "";
  let part = 0;

  const serialize = (line: DebugLine): string => {
    let text: string;
    try {
      text = JSON.stringify(line);
    } catch {
      text = JSON.stringify({ ...line, data: { unserializable: true } });
    }
    if (Buffer.byteLength(text) <= maxLineBytes) return text;
    const preview = JSON.stringify(line.data).slice(0, PREVIEW_CHARS);
    return JSON.stringify({ ...line, data: { truncated: true, bytes: Buffer.byteLength(text), preview } });
  };

  const enqueue = (line: DebugLine): void => {
    const text = `${serialize(line)}\n`;
    const entry = { text, bytes: Buffer.byteLength(text) };
    queue.push(entry);
    queuedBytes += entry.bytes;
    while (queuedBytes > MAX_QUEUE_BYTES && queue.length > 1) {
      const old = queue.shift();
      queuedBytes -= old?.bytes ?? 0;
      dropped += 1;
    }
  };

  const line = (event: DebugEvent & { ts?: number; src?: DebugSource }): DebugLine => {
    const at = event.ts !== undefined && Number.isFinite(event.ts) ? new Date(event.ts) : now();
    const data = event.data === undefined ? undefined : redactDebugData(event.data);
    return {
      ts: Number.isNaN(at.getTime()) ? now().toISOString() : at.toISOString(),
      seq: ++seq,
      session: sessionId,
      src: event.src ?? "main",
      level: event.level,
      category: event.category,
      event: event.event,
      ...(data === undefined ? {} : { data }),
    };
  };

  const headerLine = (previous: string | null): string => {
    const text = serialize(
      line({ level: "info", category: "log", event: "file-opened", data: { part, previous, maxFileBytes, verbose, ...(options.header?.() ?? {}) } }),
    );
    return `${text}\n`;
  };

  const schedule = (): void => {
    if (closed || timer !== undefined) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        void flush();
      },
      Math.max(flushMs, retryAt - Date.now()),
    );
    // The log never keeps Bee running.
    timer.unref?.();
  };

  /** Opens the next file. A name already taken gets -2, -3…, so no existing file is ever reopened or replaced. */
  async function openNext(): Promise<void> {
    const previous = path;
    if (handle) await handle.close().catch(() => undefined);
    handle = null;
    await mkdir(dir, { recursive: true });
    const when = now();
    for (let attempt = 1; ; attempt += 1) {
      const next = join(dir, debugLogFileName(when, sessionId, attempt));
      try {
        handle = await open(next, "ax");
        path = next;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 1000) throw error;
      }
    }
    part += 1;
    bytes = 0;
    fileEvents = 0;
    day = localDay(when);
    const header = headerLine(previous);
    await handle.write(header);
    bytes += Buffer.byteLength(header);
  }

  async function drain(): Promise<void> {
    if (queue.length === 0 && dropped === 0) return;
    if (dropped > 0) {
      const count = dropped;
      dropped = 0;
      enqueue(line({ level: "warn", category: "log", event: "dropped", data: { count, reason: "write failed" } }));
    }
    const batch = queue;
    queue = [];
    queuedBytes = 0;
    let written = 0;
    try {
      // A new file once the day changes, or if the user moved or removed this one while Bee runs. The old file is kept.
      const gone = path !== null && handle !== null && (await access(path).then(() => false, () => true));
      if (!handle || gone || localDay(now()) !== day) await openNext();
      let chunk: Queued[] = [];
      let chunkBytes = 0;
      const writeChunk = async () => {
        if (chunk.length === 0 || !handle) return;
        await handle.write(chunk.map((entry) => entry.text).join(""));
        bytes += chunkBytes;
        fileEvents += chunk.length;
        written += chunk.length;
        chunk = [];
        chunkBytes = 0;
      };
      for (const entry of batch) {
        // A new file once this one is full. The old file is closed and kept.
        if (bytes + chunkBytes + entry.bytes > maxFileBytes && fileEvents + chunk.length > 0) {
          await writeChunk();
          await openNext();
        }
        chunk.push(entry);
        chunkBytes += entry.bytes;
      }
      await writeChunk();
      failing = false;
      failures = 0;
      retryAt = 0;
    } catch (error) {
      // What was not written goes back in front, so a later flush tries again (bounded by MAX_QUEUE_BYTES).
      queue = [...batch.slice(written), ...queue];
      queuedBytes = queue.reduce((sum, entry) => sum + entry.bytes, 0);
      while (queuedBytes > MAX_QUEUE_BYTES && queue.length > 1) {
        queuedBytes -= queue.shift()?.bytes ?? 0;
        dropped += 1;
      }
      // Keep the file for the next try (a full disk may clear), so a failing disk does not fill up with new empty files.
      // Only a file that keeps failing is given up, and the next try opens a new one.
      failures += 1;
      if (handle && failures >= FAILURES_BEFORE_NEW_FILE) {
        await handle.close().catch(() => undefined);
        handle = null;
        failures = 0;
      }
      retryAt = Date.now() + RETRY_MS;
      if (!failing) {
        failing = true;
        options.onError?.(error);
      }
      schedule();
    }
  }

  function flush(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    chain = chain.then(drain, drain);
    return chain;
  }

  function flushSync(): void {
    clearTimeout(timer);
    timer = undefined;
    if (queue.length === 0) return;
    const text = queue.map((entry) => entry.text).join("");
    queue = [];
    queuedBytes = 0;
    try {
      // The async handle may still be busy with the last batch; its fd takes this append after it (seq keeps the order clear).
      if (handle) fd = handle.fd;
      if (fd === null || fd < 0) {
        mkdirSync(dir, { recursive: true });
        for (let attempt = 1; fd === null && attempt < 1000; attempt += 1) {
          const next = join(dir, debugLogFileName(now(), sessionId, attempt));
          try {
            fd = openSync(next, "ax");
            path = next;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
        }
      }
      if (fd !== null) writeSync(fd, text);
    } catch (error) {
      options.onError?.(error);
    }
  }

  return {
    dir,
    sessionId,
    wants: (level) => !closed && (verbose || level === "warn" || level === "error"),
    write: (event) => {
      if (closed) return;
      try {
        enqueue(line(event));
      } catch (error) {
        options.onError?.(error);
        return;
      }
      // A full queue goes at once, unless writes are failing and waiting to try again.
      if (queuedBytes >= FLUSH_BYTES && Date.now() >= retryAt) void flush();
      else schedule();
    },
    setVerbose: (next) => {
      verbose = next;
    },
    verbose: () => verbose,
    file: () => path,
    flush,
    flushSync,
    close: async () => {
      if (closed) return;
      await flush();
      closed = true;
      if (handle) await handle.close().catch(() => undefined);
      handle = null;
    },
  };
}

/**
 * A settings save for the log: the keys sent, each setting that changed with its new value (the view holds no secrets), and
 * for a secret only whether it was set or cleared.
 */
export function settingsChange(update: SettingsUpdate, before: SettingsView, after: SettingsView): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const key of Object.keys(after) as (keyof SettingsView)[]) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changed[key] = after[key];
  }
  const keys = Object.keys(update).filter((key) => update[key as keyof SettingsUpdate] !== undefined);
  return {
    keys,
    changed,
    ...(update.gatewayApiKey === undefined ? {} : { gatewayApiKey: update.gatewayApiKey.trim() === "" ? "cleared" : "set" }),
    ...(update.claudeToken === undefined ? {} : { claudeToken: update.claudeToken.trim() === "" ? "cleared" : "set" }),
  };
}
