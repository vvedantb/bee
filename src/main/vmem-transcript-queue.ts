import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { debugLog } from "../core/debug-log";
import type { McpPool, McpServerConfig } from "../core/mcp";
import type { SessionTranscript } from "../core/session-transcript";
import { TRANSCRIPT_CONNECT_TIMEOUT_MS, canSubmitTranscripts, submitTranscript, vmemSignedIn, type SubmitOutcome } from "../core/vmem-transcript";

// Finished sessions waiting to go to vmem (core/vmem-transcript.ts), kept on disk in the user data folder so a send that failed
// offline is tried again later, after a restart too. Fire and forget: enqueue returns at once and the send runs in the
// background, one at a time. The file is its own (vmem-transcripts.json, 0600); it never touches the debug log folder.
// No Electron here, so tests drive it with a temp folder and a fake submit.

/** At most this many sessions wait. The oldest go first. */
export const QUEUE_MAX_ITEMS = 20;
/** And at most this many bytes of transcript in all. */
export const QUEUE_MAX_BYTES = 10_000_000;
/** A session not sent after this long is given up. */
export const QUEUE_MAX_AGE_MS = 3 * 24 * 60 * 60_000;
/** Or after this many failed tries. */
export const QUEUE_MAX_ATTEMPTS = 12;
/** First retry delay; doubles each time up to RETRY_MAX_MS. */
export const RETRY_BASE_MS = 30_000;
export const RETRY_MAX_MS = 60 * 60_000;
/** Ids of sent sessions are kept this long and at most this many, so the same session is never sent twice. */
export const SENT_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
export const SENT_MAX = 500;

const itemSchema = z.object({
  id: z.string().min(1).max(200),
  kind: z.enum(["meeting", "conversation"]),
  title: z.string().max(500),
  transcript: z.string(),
  createdAt: z.number().finite(),
  attempts: z.number().int().nonnegative(),
  nextAt: z.number().finite(),
});
type QueueItem = z.infer<typeof itemSchema>;
// A bad entry drops that list, not the whole file.
const fileSchema = z.object({
  pending: z.array(itemSchema).catch([]).default([]),
  sent: z.array(z.object({ id: z.string(), at: z.number().finite() })).catch([]).default([]),
});
type QueueFile = z.infer<typeof fileSchema>;

/** Delay before try `attempts + 1`: 30 s, 1 min, 2 min … up to 1 h. */
export const retryDelay = (attempts: number) => Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));

export type EnqueueResult = "queued" | "duplicate";

export type TranscriptQueue = {
  /** Saves the session and starts a send in the background. "duplicate" when it was already sent or is waiting. */
  enqueue: (session: SessionTranscript) => EnqueueResult;
  /** Tries every session that is due now (app start, back online, wake from sleep). Never throws. */
  kick: () => void;
  /** One pass over due sessions, resolved when done. Tests and kick use it. */
  drain: () => Promise<void>;
  /** Clears the retry timer (app quit). The file stays. */
  stop: () => void;
  /** What waits, without transcripts (tests and logs). */
  pending: () => Array<{ id: string; attempts: number; nextAt: number }>;
};

export function createTranscriptQueue(deps: {
  path: string;
  submit: (item: { title: string; transcript: string }) => Promise<SubmitOutcome>;
  /** Read before each send: false (setting off, or no vmem) drops what waits, so a switched-off setting sends nothing more. */
  allowed: () => boolean;
  now?: () => number;
}): TranscriptQueue {
  const now = deps.now ?? Date.now;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | null = null;
  let again = false;

  function read(): QueueFile {
    try {
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(deps.path, "utf8")));
      if (parsed.success) return parsed.data;
    } catch {
      // Missing or corrupt: start empty.
    }
    return { pending: [], sent: [] };
  }

  // Through a temp file and a rename, so a crash mid-write never leaves half a file.
  function write(file: QueueFile): void {
    try {
      mkdirSync(dirname(deps.path), { recursive: true });
      const temp = `${deps.path}.tmp`;
      writeFileSync(temp, JSON.stringify(file), { mode: 0o600 });
      renameSync(temp, deps.path);
      try {
        chmodSync(deps.path, 0o600);
      } catch {
        // Windows has no chmod: the file stays in the user's own folder.
      }
    } catch (error) {
      debugLog.error("vmem", "transcript-queue-write-failed", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Drops old and surplus sessions and old sent ids. */
  function prune(file: QueueFile): QueueFile {
    const at = now();
    const fresh = file.pending.filter((item) => {
      const keep = at - item.createdAt <= QUEUE_MAX_AGE_MS;
      if (!keep) debugLog.warn("vmem", "transcript-expired", { id: item.id, kind: item.kind, attempts: item.attempts });
      return keep;
    });
    // Newest kept first, until the count or byte cap.
    const kept: QueueItem[] = [];
    let bytes = 0;
    for (const item of [...fresh].sort((a, b) => b.createdAt - a.createdAt)) {
      bytes += Buffer.byteLength(item.transcript, "utf8");
      if (kept.length >= QUEUE_MAX_ITEMS || bytes > QUEUE_MAX_BYTES) {
        debugLog.warn("vmem", "transcript-queue-full", { id: item.id, kind: item.kind });
        continue;
      }
      kept.push(item);
    }
    const sent = file.sent.filter((entry) => at - entry.at <= SENT_MAX_AGE_MS).slice(-SENT_MAX);
    return { pending: kept.sort((a, b) => a.createdAt - b.createdAt), sent };
  }

  function schedule(file: QueueFile): void {
    clearTimeout(timer);
    timer = undefined;
    const next = Math.min(...file.pending.map((item) => item.nextAt));
    if (!Number.isFinite(next)) return;
    timer = setTimeout(() => queue.kick(), Math.max(1000, next - now()));
    // A pending retry never keeps the app alive.
    timer.unref?.();
  }

  /** Re-reads the file around each change, so nothing written meanwhile is lost. */
  function update(change: (file: QueueFile) => QueueFile): QueueFile {
    const file = prune(change(read()));
    write(file);
    return file;
  }

  async function pass(): Promise<void> {
    if (!deps.allowed()) {
      const dropped = read().pending;
      if (dropped.length > 0) {
        update((file) => ({ ...file, pending: [] }));
        debugLog.info("vmem", "transcript-queue-cleared", { reason: "off or no vmem", sessions: dropped.length });
      }
      return;
    }
    // Written back, so expired and surplus sessions leave the file too.
    const due = update((file) => file).pending.filter((item) => item.nextAt <= now());
    for (const item of due) {
      // The setting may change mid-pass.
      if (!deps.allowed()) break;
      const started = now();
      let outcome: SubmitOutcome;
      try {
        outcome = await deps.submit({ title: item.title, transcript: item.transcript });
      } catch (error) {
        outcome = { status: "retry", reason: error instanceof Error ? error.message : String(error) };
      }
      const bytes = Buffer.byteLength(item.transcript, "utf8");
      if (outcome.status === "sent") {
        update((file) => ({ pending: file.pending.filter((other) => other.id !== item.id), sent: [...file.sent, { id: item.id, at: now() }] }));
        debugLog.info("vmem", "transcript-sent", { id: item.id, kind: item.kind, bytes, attempts: item.attempts + 1, ms: now() - started, receipt: outcome.receipt });
        continue;
      }
      const attempts = item.attempts + 1;
      if (outcome.status === "drop" || attempts >= QUEUE_MAX_ATTEMPTS) {
        update((file) => ({ ...file, pending: file.pending.filter((other) => other.id !== item.id) }));
        debugLog.error("vmem", "transcript-dropped", { id: item.id, kind: item.kind, bytes, attempts, reason: outcome.reason });
        continue;
      }
      const nextAt = now() + retryDelay(attempts);
      update((file) => ({ ...file, pending: file.pending.map((other) => (other.id === item.id ? { ...other, attempts, nextAt } : other)) }));
      debugLog.warn("vmem", "transcript-retry", { id: item.id, kind: item.kind, attempts, retryInMs: nextAt - now(), reason: outcome.reason });
    }
  }

  const queue: TranscriptQueue = {
    enqueue(session) {
      const file = read();
      if (file.sent.some((entry) => entry.id === session.id) || file.pending.some((item) => item.id === session.id)) {
        debugLog.info("vmem", "transcript-duplicate", { id: session.id, kind: session.kind });
        return "duplicate";
      }
      const item: QueueItem = { ...session, attempts: 0, nextAt: now() };
      update((current) => ({ ...current, pending: [...current.pending, item] }));
      debugLog.info("vmem", "transcript-queued", { id: session.id, kind: session.kind, bytes: Buffer.byteLength(session.transcript, "utf8") });
      queue.kick();
      return "queued";
    },
    kick() {
      void queue.drain().catch((error: unknown) => debugLog.error("vmem", "transcript-queue-failed", { message: error instanceof Error ? error.message : String(error) }));
    },
    drain() {
      // One pass at a time; a kick during a pass runs one more pass after it.
      if (running) {
        again = true;
        return running;
      }
      running = (async () => {
        try {
          do {
            again = false;
            await pass();
          } while (again);
        } finally {
          running = null;
          schedule(read());
        }
      })();
      return running;
    },
    stop() {
      clearTimeout(timer);
      timer = undefined;
    },
    pending: () => read().pending.map((item) => ({ id: item.id, attempts: item.attempts, nextAt: item.nextAt })),
  };
  return queue;
}

/** What the vmem sender needs from Settings (main/settings.ts). */
export type TranscriptSettings = {
  /** The "Send finished sessions to vmem" toggle, effective value. */
  enabled: boolean;
  /** The enabled vmem connector with secrets, or undefined. */
  config: McpServerConfig | undefined;
  /** The saved record says it lists transcript_submit (canSubmitTranscripts). */
  listed: boolean;
};

export type VmemTranscripts = {
  /** Queues a finished session when the setting is on and vmem takes transcripts. Returns at once; never throws. */
  submit: (session: SessionTranscript | null) => void;
  kick: () => void;
  stop: () => void;
};

/**
 * The queue wired to Settings and the shared MCP pool. A session is queued only with the setting on and an enabled vmem
 * connector that lists transcript_submit. When the saved tool list does not have it (an older list), the live list is checked
 * once in the background, so a vmem that gained the tool after sign-in still works.
 */
export function createVmemTranscripts(deps: { path: string; settings: () => TranscriptSettings; pool: Pick<McpPool, "ensure" | "list" | "drop">; now?: () => number }): VmemTranscripts {
  const allowed = () => {
    const current = deps.settings();
    return current.enabled && current.config !== undefined;
  };
  const queue = createTranscriptQueue({
    path: deps.path,
    allowed,
    now: deps.now,
    submit: (payload) =>
      submitTranscript({ config: () => deps.settings().config, connect: (config) => deps.pool.ensure(config, TRANSCRIPT_CONNECT_TIMEOUT_MS), drop: deps.pool.drop }, payload),
  });

  async function ready(current: TranscriptSettings): Promise<boolean> {
    if (current.listed) return true;
    const config = current.config;
    if (!config || !vmemSignedIn(config)) return false;
    try {
      const listed = await deps.pool.list(config, TRANSCRIPT_CONNECT_TIMEOUT_MS);
      return canSubmitTranscripts({ serverInfoName: config.serverInfoName, tools: listed.tools, disabledTools: config.disabledTools });
    } catch {
      return false;
    }
  }

  return {
    submit(session) {
      if (!session) return;
      const current = deps.settings();
      if (!current.enabled) return;
      if (!current.config) {
        debugLog.debug("vmem", "transcript-skipped", { id: session.id, kind: session.kind, reason: "no vmem connector" });
        return;
      }
      void ready(current)
        .then((ok) => {
          if (!ok) {
            debugLog.info("vmem", "transcript-skipped", { id: session.id, kind: session.kind, reason: "no transcript_submit tool" });
            return;
          }
          queue.enqueue(session);
        })
        .catch((error: unknown) => debugLog.error("vmem", "transcript-submit-failed", { id: session.id, message: error instanceof Error ? error.message : String(error) }));
    },
    kick: queue.kick,
    stop: queue.stop,
  };
}
