import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpConnection, McpServerConfig, McpToolCache } from "../core/mcp";
import type { SessionTranscript } from "../core/session-transcript";
import type { SubmitOutcome } from "../core/vmem-transcript";
import {
  QUEUE_MAX_AGE_MS,
  QUEUE_MAX_ATTEMPTS,
  QUEUE_MAX_ITEMS,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  createTranscriptQueue,
  createVmemTranscripts,
  retryDelay,
  type TranscriptSettings,
} from "./vmem-transcript-queue";

let dir: string;
let path: string;
let clock: number;
const now = () => clock;

const session = (id: string, extra: Partial<SessionTranscript> = {}): SessionTranscript => ({
  id,
  kind: "meeting",
  title: `Meeting ${id}`,
  transcript: `What was said:\n${id}`,
  createdAt: clock,
  ...extra,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bee-vmem-queue-"));
  path = join(dir, "vmem-transcripts.json");
  clock = 1_000_000;
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

/** A queue whose sends wait for the test to call drain, so each step is explicit. */
function makeQueue(submit: (item: { title: string; transcript: string }) => Promise<SubmitOutcome>, allowed = () => true) {
  const queue = createTranscriptQueue({ path, submit, allowed, now });
  return queue;
}

describe("retryDelay", () => {
  it("doubles from 30 s up to an hour", () => {
    expect([1, 2, 3].map(retryDelay)).toEqual([RETRY_BASE_MS, RETRY_BASE_MS * 2, RETRY_BASE_MS * 4]);
    expect(retryDelay(40)).toBe(RETRY_MAX_MS);
  });
});

describe("createTranscriptQueue", () => {
  it("sends a session once, remembers it, and refuses the same id again", async () => {
    const submit = vi.fn(async (): Promise<SubmitOutcome> => ({ status: "sent", receipt: "{}" }));
    const queue = makeQueue(submit);
    expect(queue.enqueue(session("a"))).toBe("queued");
    await queue.drain();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith({ title: "Meeting a", transcript: "What was said:\na" });
    expect(queue.pending()).toEqual([]);
    expect(queue.enqueue(session("a"))).toBe("duplicate");
    // A new queue on the same file (an app restart) remembers it too.
    expect(makeQueue(submit).enqueue(session("a"))).toBe("duplicate");
    await queue.drain();
    expect(submit).toHaveBeenCalledTimes(1);
    queue.stop();
  });

  it("refuses a session that is already waiting", async () => {
    const queue = makeQueue(async () => ({ status: "retry", reason: "offline" }));
    queue.enqueue(session("a"));
    expect(queue.enqueue(session("a"))).toBe("duplicate");
    await queue.drain();
    expect(queue.pending()).toHaveLength(1);
    queue.stop();
  });

  it("keeps a failed send on disk and retries it with backoff, after a restart too", async () => {
    let online = false;
    const submit = vi.fn(async (): Promise<SubmitOutcome> => (online ? { status: "sent", receipt: "{}" } : { status: "retry", reason: "offline" }));
    const queue = makeQueue(submit);
    queue.enqueue(session("a"));
    await queue.drain();
    expect(queue.pending()).toEqual([{ id: "a", attempts: 1, nextAt: clock + RETRY_BASE_MS }]);
    // Not due yet: nothing is sent.
    await queue.drain();
    expect(submit).toHaveBeenCalledTimes(1);
    queue.stop();
    // Unix mode bits do not apply on Windows (NTFS uses ACLs).
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);

    clock += RETRY_BASE_MS;
    online = true;
    const restarted = makeQueue(submit);
    await restarted.drain();
    expect(submit).toHaveBeenCalledTimes(2);
    expect(restarted.pending()).toEqual([]);
    restarted.stop();
  });

  it("gives up after too many tries, and drops at once when vmem cannot take it", async () => {
    const queue = makeQueue(async (item) => (item.title === "Meeting big" ? { status: "drop", reason: "too large" } : { status: "retry", reason: "offline" }));
    queue.enqueue(session("big"));
    queue.enqueue(session("a"));
    await queue.drain();
    expect(queue.pending().map((item) => item.id)).toEqual(["a"]);
    for (let attempt = 1; attempt < QUEUE_MAX_ATTEMPTS; attempt++) {
      clock += RETRY_MAX_MS;
      await queue.drain();
    }
    expect(queue.pending()).toEqual([]);
    queue.stop();
  });

  it("drops what waits once the setting is off, and sends nothing", async () => {
    let allowed = true;
    const submit = vi.fn(async (): Promise<SubmitOutcome> => ({ status: "retry", reason: "offline" }));
    const queue = makeQueue(submit, () => allowed);
    queue.enqueue(session("a"));
    await queue.drain();
    allowed = false;
    clock += RETRY_BASE_MS;
    await queue.drain();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(queue.pending()).toEqual([]);
    queue.stop();
  });

  it("caps the waiting sessions, dropping the oldest", async () => {
    // The first send never finishes, so every later session waits on disk.
    const queue = makeQueue(() => new Promise<SubmitOutcome>(() => undefined));
    for (let index = 0; index < QUEUE_MAX_ITEMS + 3; index++) {
      clock += 1;
      queue.enqueue(session(`s${index}`));
    }
    const ids = queue.pending().map((item) => item.id);
    expect(ids).toHaveLength(QUEUE_MAX_ITEMS);
    expect(ids[0]).toBe("s3");
    expect(ids.at(-1)).toBe(`s${QUEUE_MAX_ITEMS + 2}`);
    queue.stop();
  });

  it("gives up a session that has waited too long", async () => {
    const submit = vi.fn(async (): Promise<SubmitOutcome> => ({ status: "retry", reason: "offline" }));
    const queue = makeQueue(submit);
    queue.enqueue(session("a"));
    await queue.drain();
    clock += QUEUE_MAX_AGE_MS + 1;
    await queue.drain();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(queue.pending()).toEqual([]);
    queue.stop();
  });

  it("reads a missing or corrupt file as empty", async () => {
    writeFileSync(path, "{not json");
    const queue = makeQueue(async () => ({ status: "sent", receipt: "" }));
    expect(queue.pending()).toEqual([]);
    expect(queue.enqueue(session("a"))).toBe("queued");
    await queue.drain();
    expect(JSON.parse(readFileSync(path, "utf8")).sent.map((entry: { id: string }) => entry.id)).toEqual(["a"]);
    queue.stop();
  });
});

describe("createVmemTranscripts", () => {
  const config: McpServerConfig = { id: "v", name: "Memory", transport: "http", url: "https://example.com/mcp", auth: { type: "none" }, oauthSignedIn: true, serverInfoName: "vmem" };
  const tools = [{ name: "transcript_submit", description: "", inputSchema: {} }];

  function setup(settings: Partial<TranscriptSettings>, options: { listed?: McpToolCache["tools"] } = {}) {
    const call = vi.fn<McpConnection["call"]>(async () => '{"status":"pending"}');
    const pool = {
      ensure: vi.fn(async (): Promise<McpConnection> => ({ tools, call, close: async () => undefined })),
      list: vi.fn(async (): Promise<McpToolCache> => ({ configHash: "", fetchedAt: 0, tools: options.listed ?? [] })),
      drop: vi.fn(),
    };
    const transcripts = createVmemTranscripts({ path, now, pool, settings: () => ({ enabled: true, config, listed: true, ...settings }) });
    return { transcripts, call, pool };
  }

  const settle = async () => {
    for (let index = 0; index < 10; index++) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  it("sends a finished session through transcript_submit", async () => {
    const { transcripts, call } = setup({});
    transcripts.submit(session("a"));
    await settle();
    expect(call).toHaveBeenCalledWith("transcript_submit", { transcript: "What was said:\na", title: "Meeting a" }, expect.any(Number), expect.any(Number));
    transcripts.stop();
  });

  it("sends nothing with the setting off, without vmem, for an empty session, or when vmem lacks the tool", async () => {
    for (const settings of [{ enabled: false }, { config: undefined, listed: false }, { listed: false }]) {
      const { transcripts, call, pool } = setup(settings);
      transcripts.submit(session("a"));
      transcripts.submit(null);
      await settle();
      expect(call).not.toHaveBeenCalled();
      expect(pool.ensure).not.toHaveBeenCalled();
      transcripts.stop();
    }
    expect(existsSync(path)).toBe(false);
  });

  it("checks the live tool list once when the saved one is older than the server", async () => {
    const { transcripts, call, pool } = setup({ listed: false }, { listed: tools });
    transcripts.submit(session("a"));
    await settle();
    expect(pool.list).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledTimes(1);
    transcripts.stop();
  });
});
