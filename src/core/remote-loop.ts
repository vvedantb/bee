import { BEE_LONG_POLL_MS, JOB_RESULT_MAX, nextJobResponseSchema, remoteJobSchema, type JobResult, type RemoteJob } from "../shared/bee-mcp";
import { debugLog, errorData } from "./debug-log";

// The Bee MCP server's desktop side: while the user is signed in and "Let other AIs use Bee" is on, Bee long-polls the cloud for a
// job (shared/bee-mcp.ts), runs it (main/meeting-ipc.ts, on the island) and posts the result. One job at a time. Each poll also
// tells the cloud Bee is running; when the loop stops, the cloud says Bee isn't running within 45 s. Logs: job id, tool, outcome
// and time, never a name or message text.

export type RemoteLoopDeps = {
  /** The cloud's HTTP site, e.g. https://<deployment>.convex.site. */
  baseUrl: string;
  fetch: typeof globalThis.fetch;
  /** A fresh Clerk session token, or null while signed out. */
  token: () => Promise<string | null>;
  /** The setting, read before every poll. */
  enabled: () => boolean;
  /** Runs a job; resolves with its result. Must not throw. */
  run: (job: RemoteJob) => Promise<Omit<JobResult, "id">>;
  /** Waits, or ends early when the signal aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
};

// Signed out: check again soon (the token comes from the renderer, which may still be loading).
export const SIGNED_OUT_WAIT_MS = 5000;
// After a failed poll or post: 5 s once, then 30 s until one works.
export const RETRY_FIRST_MS = 5000;
export const RETRY_LATER_MS = 30_000;
const POLL_TIMEOUT_MS = BEE_LONG_POLL_MS + 15_000;
const POST_TIMEOUT_MS = 15_000;
export const UNREADABLE_JOB = "This Bee cannot read that request. Update Bee and try again.";

class HttpStatusError extends Error {
  constructor(
    path: string,
    readonly status: number,
  ) {
    super(`${path} answered ${status}`);
  }
}

export type RemoteLoop = {
  /** Starts the loop when the setting is on and it is not running; stops it when the setting is off. Call after a settings change. */
  sync: () => void;
  stop: () => void;
  running: () => boolean;
  /** Resolves when the current loop has ended (tests). */
  idle: () => Promise<void>;
};

export function createRemoteLoop(deps: RemoteLoopDeps): RemoteLoop {
  const base = deps.baseUrl.replace(/\/+$/, "");
  let controller: AbortController | null = null;
  let loop: Promise<void> = Promise.resolve();

  const post = async (path: string, token: string, body: object, signal: AbortSignal, timeoutMs: number): Promise<Response> => {
    const response = await deps.fetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });
    if (!response.ok) throw new HttpStatusError(path, response.status);
    return response;
  };

  /** Posts a job's result. A 404 means the AI stopped waiting (it expired): nothing more to do. */
  const report = async (id: string, result: Omit<JobResult, "id">, signal: AbortSignal): Promise<void> => {
    const token = await deps.token();
    if (!token) throw new Error("signed out before the result was sent");
    const body: JobResult = { id, ok: result.ok, text: result.text.slice(0, JOB_RESULT_MAX) };
    try {
      await post("/bee/jobs/result", token, body, signal, POST_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof HttpStatusError && error.status === 404) {
        debugLog.info("remote", "result-late", { id });
        return;
      }
      throw error;
    }
  };

  async function runLoop(signal: AbortSignal): Promise<void> {
    let failures = 0;
    debugLog.info("remote", "loop-start");
    while (!signal.aborted && deps.enabled()) {
      const token = await deps.token();
      if (signal.aborted) break;
      if (!token) {
        await deps.sleep(SIGNED_OUT_WAIT_MS, signal);
        continue;
      }
      try {
        const response = await post("/bee/jobs/next", token, {}, signal, POLL_TIMEOUT_MS);
        const raw = nextJobResponseSchema.parse(await response.json()).job;
        failures = 0;
        if (!raw) continue;
        const parsed = remoteJobSchema.safeParse(raw);
        const started = performance.now();
        if (!parsed.success) {
          debugLog.warn("remote", "job-unreadable", { id: raw.id });
          await report(raw.id, { ok: false, text: UNREADABLE_JOB }, signal);
          continue;
        }
        const job = parsed.data;
        debugLog.info("remote", "job-start", { id: job.id, tool: job.tool });
        const result = await deps.run(job);
        await report(job.id, result, signal);
        debugLog.info("remote", "job-done", { id: job.id, tool: job.tool, ok: result.ok, ms: Math.round(performance.now() - started) });
      } catch (error) {
        if (signal.aborted) break;
        failures += 1;
        const wait = failures === 1 ? RETRY_FIRST_MS : RETRY_LATER_MS;
        debugLog.warn("remote", "poll-failed", { failures, waitMs: wait, error: errorData(error).message });
        await deps.sleep(wait, signal);
      }
    }
    debugLog.info("remote", "loop-stop", { aborted: signal.aborted });
  }

  const stop = () => {
    controller?.abort();
    controller = null;
  };

  return {
    sync: () => {
      if (!deps.enabled()) return stop();
      if (controller) return;
      const current = new AbortController();
      controller = current;
      loop = runLoop(current.signal).finally(() => {
        if (controller === current) controller = null;
      });
    },
    stop,
    running: () => controller !== null,
    idle: () => loop,
  };
}

/** A sleep that ends early on abort. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
