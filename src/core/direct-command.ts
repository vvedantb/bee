import { tool } from "ai";
import { z } from "zod";
import type { PipelineResult } from "../shared/ipc";
import type { ComputerRun } from "./agent-desktop-envelope";
import { COMPUTER_MAX_STEPS, createRunControl, stopLine, type ComputerPlatform, type RunControl } from "./computer-control";
import { computerTools, type ConfirmRequest } from "./computer-tools";
import { computerAccess, runComputerUse, wantsComputerUse } from "./computer-use";
import { debugLog, errorData } from "./debug-log";
import { GUIDE_MODEL, NO_GATEWAY_KEY, type BeeGateway } from "./gateway";
import type { McpTools } from "./mcp";
import { routeCommand, type DesktopActionResult, type DesktopActions } from "./desktop-actions";
import { desktopTools } from "./desktop-tools";
import { guideWithLuna, noteCitation, type LunaToolActivity, type TipFields } from "./luna";
import type { Snippet } from "./notes";
import { loadMcp } from "./pipeline";
import { retrieve } from "./retrieve";
import { tipKey } from "./steering";
import { needsWebSearch, type SearchLocation } from "./web-search";

// A direct request to Bee: a mic phrase that started with the wake word ("Bee, open Teams", core/wake-word.ts). Bee answers
// the user, not the meeting. "Open <a known app>" and "open <a web address>" run at once with no AI call. A task on screen
// ("send Sam a message in Discord", core/computer-use.ts wantsComputerUse) runs the computer-use loop. Anything else goes to
// Luna with the desktop tools, and use_computer to hand a task on screen over to the loop. The result has the pipeline's
// shape, so the island shows it like tips: action lines first ("Opened Teams"), then the reply, or the loop's one last line.
// No Jev: there is no meeting turn to rank notes for.

const RETRIEVE_LIMIT = 5;
const GUIDE_NOTE_LIMIT = 3;
const MCP_ERRORS_MAX = 20;
const MCP_ERROR_CHARS = 300;
// Streamed lines over IPC (shared/ipc.ts lunaPartialSchema).
const PARTIAL_MAX = 5;

const FAST_TOOL = { "open-app": "open_app", "focus-app": "focus_window", "open-url": "open_url" } as const;

/** Action lines then reply lines, without repeats (the reply may say "Opened Teams." again). */
function joinLines(actions: readonly string[], reply: TipFields): TipFields {
  const seen = new Set(actions.map((line) => tipKey(line).replace(/[.!]+$/, "").toLowerCase()));
  const tips = [...actions];
  const tipSources: (string | null)[] = actions.map(() => null);
  reply.tips.forEach((tip, index) => {
    const key = tipKey(tip).replace(/[.!]+$/, "").toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    tips.push(tip);
    tipSources.push(reply.tipSources[index] ?? null);
  });
  return { tips, tipSources };
}

const timings = (patch: Partial<PipelineResult["timingsMs"]> = {}): PipelineResult["timingsMs"] => ({ retrieve: 0, rank: 0, guide: 0, mcp: 0, lunaFirstToken: null, lunaTotal: 0, ...patch });

/** Main's side of computer use (main/meeting-ipc.ts): the runner, the setting, the island's Confirm and step line. */
export type ComputerHost = {
  platform: ComputerPlatform;
  /** agent-desktop's computer-use runner (main/agent-desktop.ts). Never the meeting window reader's. */
  run: ComputerRun;
  /** "Ask before sending or deleting", read per action. */
  askFirst: () => boolean;
  /** Shows the Confirm prompt in the island; true for Confirm. */
  confirm: (request: ConfirmRequest, signal: AbortSignal) => Promise<boolean>;
  /** The island's step line ("Clicking Send…"). */
  onStep?: (label: string) => void;
  /** The run's controls, so main can stop it (the Stop button, "Bee, stop"). */
  onControl?: (control: RunControl) => void;
  /** Limits, for tests. */
  maxSteps?: number;
  maxMs?: number;
};

const lineResult = (line: string, patch: Partial<PipelineResult["timingsMs"]> = {}): PipelineResult => ({
  notes: [],
  rankSource: "fallback",
  rankError: null,
  tips: [line],
  tipSources: [null],
  sources: [],
  guideError: null,
  timingsMs: timings(patch),
});

/** The computer-use loop for one request, ending with one line for the island. On a Mac without Accessibility, no loop runs. */
async function runComputerCommand(args: {
  command: string;
  transcript?: string[];
  host: ComputerHost;
  actions: DesktopActions;
  gateway: BeeGateway;
  signal?: AbortSignal;
  onActivity?: (activity: LunaToolActivity) => void;
}): Promise<PipelineResult> {
  const { host } = args;
  const maxSteps = host.maxSteps ?? COMPUTER_MAX_STEPS;
  const control = createRunControl({ maxSteps, maxMs: host.maxMs, signal: args.signal });
  host.onControl?.(control);
  const started = performance.now();
  // The first step line shows the island's Stop button at once, before the access check.
  host.onStep?.("Starting…");
  try {
    debugLog.info("computer", "run-start", { platform: host.platform, maxSteps, maxMs: host.maxMs ?? null, askFirst: host.askFirst(), command: args.command });
    if (host.platform === "mac") {
      const access = await computerAccess(host.run, control.signal);
      debugLog.info("computer", "access", access);
      if (control.reason()) return lineResult(stopLine(control.reason() ?? "user", { platform: host.platform }));
      if (access.accessibility === "denied") {
        console.debug("perf computer access=denied");
        return lineResult(stopLine("permission", { platform: host.platform }));
      }
    }
    const tools = computerTools({
      run: host.run,
      desktop: args.actions,
      control,
      platform: host.platform,
      askFirst: host.askFirst,
      confirm: host.confirm,
      onStep: host.onStep,
      onActivity: args.onActivity,
    });
    const outcome = await runComputerUse({
      model: args.gateway.languageModel(GUIDE_MODEL),
      command: args.command,
      transcript: args.transcript,
      tools,
      control,
      platform: host.platform,
      maxSteps,
    });
    const guide = performance.now() - started;
    debugLog.info("computer", "run-end", { ...outcome, reason: control.reason(), declined: control.declined(), ms: Math.round(guide) });
    if (outcome.error) return { ...lineResult(outcome.line, { guide, lunaTotal: guide }), tips: [], tipSources: [], guideError: outcome.line };
    return lineResult(outcome.line, { guide, lunaTotal: guide });
  } finally {
    control.dispose();
  }
}

export async function runDirectCommand(args: {
  /** The request after the wake word: "open Teams", "what's 15% of 18000?". */
  command: string;
  /** The latest meeting lines, as background for a request about the meeting. Never answered as tips. */
  transcript?: string[];
  meetingBrief?: string;
  meetingTerms?: string;
  searchLocation?: SearchLocation;
  snippets: Snippet[];
  gateway: BeeGateway | null;
  notesDir?: string;
  extraRoots?: readonly string[];
  loadMcpTools?: () => Promise<McpTools>;
  /** Main's desktop actions (main/desktop-actions.ts). Null: no desktop tools, so the AI only answers. */
  actions: DesktopActions | null;
  /** Computer use (main/meeting-ipc.ts). Null or absent: Bee cannot operate apps here, so the AI says so. */
  computer?: ComputerHost | null;
  onActivity?: (activity: LunaToolActivity) => void;
  onPartial?: (partial: TipFields) => void;
  signal?: AbortSignal;
}): Promise<PipelineResult> {
  const command = args.command.replace(/\s+/g, " ").trim();
  const route = routeCommand(command);
  debugLog.info("ai", "command-route", { command, route, computer: Boolean(args.computer), desktop: Boolean(args.actions), wantsComputer: wantsComputerUse(command) });
  if (route.kind !== "ai" && args.actions) {
    const tool = FAST_TOOL[route.kind];
    const actions = args.actions;
    args.onActivity?.({ tool, phase: "start" });
    let result: DesktopActionResult;
    try {
      result = await (route.kind === "open-url" ? actions.openUrl(route.url) : route.kind === "open-app" ? actions.openApp(route.name) : actions.focusWindow({ app: route.name }));
    } catch (error) {
      debugLog.warn("desktop", "action-failed", { route, error: errorData(error) });
      result = { ok: false, message: "That desktop action failed" };
    } finally {
      args.onActivity?.({ tool, phase: "end" });
    }
    debugLog.info("desktop", "fast-action", { route, result });
    console.debug(`perf command fast ${route.kind} ok=${result.ok ? 1 : 0}`);
    return { notes: [], rankSource: "fallback", rankError: null, tips: [result.message], tipSources: [null], sources: [], guideError: null, timingsMs: timings() };
  }

  // A task on screen goes straight to the loop: it needs no notes, connectors or web search.
  const computer = args.computer && args.actions && args.gateway ? { host: args.computer, actions: args.actions, gateway: args.gateway } : null;
  const loop = () =>
    computer ? runComputerCommand({ ...computer, command, transcript: args.transcript, signal: args.signal, onActivity: args.onActivity }) : Promise.reject(new Error("no computer use"));
  if (computer && wantsComputerUse(command)) {
    console.debug("perf command computer");
    return loop();
  }

  const t0 = performance.now();
  const retrieved = retrieve(command, args.snippets, RETRIEVE_LIMIT, args.meetingTerms);
  const candidates = retrieved.map(({ snippet, score }) => ({ ...snippet, retrieveScore: score }));
  const retrieveMs = performance.now() - t0;
  const guideNotes = candidates.slice(0, GUIDE_NOTE_LIMIT);
  const notes = candidates.map((note, index) => ({ ...note, jevScore: null, cite: index < GUIDE_NOTE_LIMIT ? noteCitation(index) : null }));
  if (!args.gateway) {
    return { notes, rankSource: "fallback", rankError: NO_GATEWAY_KEY, tips: [], tipSources: [], sources: [], guideError: NO_GATEWAY_KEY, timingsMs: timings({ retrieve: retrieveMs }) };
  }

  const mcpStarted = performance.now();
  const mcp = await loadMcp(args.loadMcpTools);
  const mcpMs = performance.now() - mcpStarted;
  // Action lines show as soon as each lands, ahead of the reply streaming in.
  const actionLines: string[] = [];
  let streamed: TipFields = { tips: [], tipSources: [] };
  const emit = () => {
    const joined = joinLines(actionLines, streamed);
    args.onPartial?.({ tips: joined.tips.slice(0, PARTIAL_MAX), tipSources: joined.tipSources.slice(0, PARTIAL_MAX) });
  };
  // use_computer hands a task on screen over to the loop: this answer stops at once, and the loop runs instead.
  const handOver = new AbortController();
  const tools = args.actions
    ? {
        ...desktopTools(args.actions, (line) => {
          debugLog.info("desktop", "action-line", { line });
          actionLines.push(line);
          emit();
        }),
        ...(computer
          ? {
              use_computer: tool({
                description: "Do the request on screen, step by step: click, type, send, close or change things in other apps. Call it once, with nothing else.",
                inputSchema: z.object({}),
                execute: async () => {
                  debugLog.info("ai", "computer-handover", { command });
                  handOver.abort();
                  return "Bee is doing it on screen.";
                },
              }),
            }
          : {}),
      }
    : undefined;
  const started = performance.now();
  const guide = await guideWithLuna({
    model: args.gateway.languageModel(GUIDE_MODEL),
    transcript: args.transcript ?? [],
    command,
    notes: guideNotes,
    meetingBrief: args.meetingBrief,
    webSearch: needsWebSearch({ lines: [command] }),
    searchLocation: args.searchLocation,
    notesDir: args.notesDir,
    extraRoots: args.extraRoots,
    extraTools: mcp?.tools,
    connectedServers: mcp?.servers,
    unavailableServers: mcp?.errors.map(({ server, error }) => ({ name: server, error })),
    desktopTools: tools,
    computerUse: computer !== null,
    onActivity: args.onActivity,
    onPartial: (partial) => {
      if (handOver.signal.aborted) return;
      streamed = partial;
      emit();
    },
    signal: args.signal ? AbortSignal.any([args.signal, handOver.signal]) : handOver.signal,
  });
  if (handOver.signal.aborted && !args.signal?.aborted) {
    void mcp?.close().catch(() => undefined);
    console.debug("perf command computer handover");
    return loop();
  }
  const guideMs = performance.now() - started;
  const closeStarted = performance.now();
  void mcp?.close().catch(() => undefined).finally(() => console.debug(`perf mcp-close ${Math.round(performance.now() - closeStarted)}ms`));
  console.debug(`perf command actions=${actionLines.length} mcp ${Math.round(mcpMs)}ms guide ${Math.round(guideMs)}ms`);
  const shown = joinLines(actionLines, guide);
  return {
    notes,
    rankSource: "fallback",
    rankError: null,
    ...shown,
    sources: guide.sources,
    // After an action, no further text is a fine end: the action line is the answer.
    guideError: guide.empty && actionLines.length > 0 ? null : guide.error,
    guideNote: guide.skipped,
    mcpErrors: (mcp?.errors ?? []).slice(0, MCP_ERRORS_MAX).map(({ server, error }) => ({ server: server.slice(0, 200), error: error.slice(0, MCP_ERROR_CHARS) })),
    timingsMs: timings({ retrieve: retrieveMs, mcp: mcpMs, guide: guideMs, lunaFirstToken: guide.firstTokenMs, lunaTotal: guide.totalMs }),
  };
}
