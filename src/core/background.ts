import type { ModelMessage, ToolSet } from "ai";
import type { PipelineResult } from "../shared/ipc";
import { assistantMessage, userMessage } from "./bee-history";
import type { CommandAgent } from "./claude-agent";
import { debugLog, errorData } from "./debug-log";
import { MAX_DIRECT_LINES, parseLunaTips, tipFields } from "./luna";
import { sourcesFromGenerateResult } from "./tools";

// Background tasks: "Bee, draft the release notes and post them in Slack" goes on while the user works and asks Bee other things.
// The answer path hands a long job over (direct-command.ts run_in_background); it runs here, in a fork of the Claude Code session
// (core/claude-agent.ts background), so it knows the conversation but never blocks the next request. No computer use: it would
// fight the user for the screen. When it ends, its result goes to the island (main/meeting-ipc.ts) and back into the session as a
// note, so "what did it find?" works. Pure: no Electron.

/** Background tasks that may run at once. */
export const BACKGROUND_MAX = 3;
/** Finished tasks kept for the Live tab. */
const FINISHED_KEPT = 5;
const TITLE_MAX = 60;

export const BACKGROUND_SYSTEM = [
  "You are Bee, doing a task in the background that the user handed you a moment ago. They are not watching: do the whole task without asking them anything, using Claude Code's tools, the user's MCP servers and Bee's memory. You cannot use the screen or apps on it.",
  "If something needs the user's decision, stop at that point and say what is left for them.",
  `When done, reply in at most ${MAX_DIRECT_LINES} short lines, each starting with "- ": what you did and the result, with any link or file path. Write "Bee" where you would write "I".`,
].join("\n");

export type BackgroundStatus = "running" | "done" | "failed" | "stopped";

export type BackgroundJob = {
  id: string;
  title: string;
  status: BackgroundStatus;
  /** The tool running now (Bee's name for it), for the Live tab's step line. */
  tool: string | null;
  /** The result for the island, once done or failed. */
  result: PipelineResult | null;
  startedAt: number;
};

const emptyTimings = { retrieve: 0, rank: 0, guide: 0, mcp: 0, lunaFirstToken: null, lunaTotal: 0 };

function jobResult(tips: string[], error: string | null, sources: PipelineResult["sources"], ms: number): PipelineResult {
  return { notes: [], rankSource: "fallback", rankError: null, tips, tipSources: tips.map(() => null), sources, guideError: error, timingsMs: { ...emptyTimings, guide: ms, lunaTotal: ms } };
}

export type BackgroundJobs = ReturnType<typeof createBackgroundJobs>;

export function createBackgroundJobs(deps: {
  /** The agent on the user's Claude Code (main/claude-code.ts), or why there is none. */
  agent: () => Promise<{ agent: CommandAgent } | { error: string }>;
  /** Bee's tools a task may use: memory, never the screen. */
  tools: () => ToolSet;
  /** Bee's history, for a session with nothing to fork yet. */
  history: () => readonly ModelMessage[];
  onUpdate: (job: BackgroundJob) => void;
  /** The finished task's messages, for Bee's history. */
  onTurn?: (messages: ModelMessage[]) => void;
  now?: () => number;
}) {
  const jobs: BackgroundJob[] = [];
  const controllers = new Map<string, AbortController>();
  let seq = 0;
  const now = deps.now ?? Date.now;

  function update(job: BackgroundJob, patch: Partial<BackgroundJob>): void {
    Object.assign(job, patch);
    deps.onUpdate({ ...job });
  }

  async function run(job: BackgroundJob, task: string, controller: AbortController): Promise<void> {
    const started = now();
    try {
      const got = await deps.agent();
      if ("error" in got) throw new Error(got.error);
      const { agent } = got;
      if (!agent.background) throw new Error("Background tasks need Claude Code.");
      const result = await agent.background({
        tier: "plan",
        system: BACKGROUND_SYSTEM,
        history: deps.history(),
        content: [`The background task "${job.title}":\n${task}`],
        tools: deps.tools(),
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "tool-start") update(job, { tool: event.tool });
          else if (event.type === "tool-end") update(job, { tool: null });
        },
      });
      const tips = tipFields(parseLunaTips(result.text, MAX_DIRECT_LINES)).tips;
      const lines = tips.length > 0 ? tips : ["Done."];
      const turn = [userMessage(`(Background task) ${job.title}: ${task}`), assistantMessage(lines.map((line) => `- ${line}`).join("\n"))];
      agent.note?.(turn);
      deps.onTurn?.(turn);
      update(job, { status: "done", tool: null, result: jobResult(lines, null, sourcesFromGenerateResult({ sources: result.sources }), now() - started) });
    } catch (error) {
      const stopped = controller.signal.aborted;
      debugLog.warn("ai", "background-failed", { id: job.id, stopped, error: errorData(error) });
      const message = stopped ? `Stopped: ${job.title}.` : `${job.title} failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300);
      update(job, { status: stopped ? "stopped" : "failed", tool: null, result: jobResult([], message, [], now() - started) });
    } finally {
      controllers.delete(job.id);
      // Keep the running tasks and the newest finished ones.
      const finished = jobs.filter((item) => item.status !== "running");
      for (const old of finished.slice(0, Math.max(0, finished.length - FINISHED_KEPT))) jobs.splice(jobs.indexOf(old), 1);
    }
  }

  return {
    /** Starts a task, or says why it cannot (too many running). The reply is for the AI that handed it over. */
    start(title: string, task: string): { ok: true; id: string } | { ok: false; message: string } {
      const running = jobs.filter((job) => job.status === "running").length;
      if (running >= BACKGROUND_MAX) return { ok: false, message: `Bee is already running ${running} background tasks. Say so, and that the user can try again when one finishes.` };
      seq += 1;
      const job: BackgroundJob = { id: `bg-${now().toString(36)}-${seq}`, title: title.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX) || "Background task", status: "running", tool: null, result: null, startedAt: now() };
      const controller = new AbortController();
      jobs.push(job);
      controllers.set(job.id, controller);
      deps.onUpdate({ ...job });
      debugLog.info("ai", "background-start", { id: job.id, title: job.title });
      void run(job, task, controller);
      return { ok: true, id: job.id };
    },
    stop(id: string): boolean {
      const controller = controllers.get(id);
      controller?.abort(new Error("stopped"));
      return Boolean(controller);
    },
    list: (): BackgroundJob[] => jobs.map((job) => ({ ...job })),
  };
}
