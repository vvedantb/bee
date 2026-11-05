import { tool, type ModelMessage } from "ai";
import { z } from "zod";
import type { PipelineResult } from "../shared/ipc";
import type { ComputerRun } from "./agent-desktop-envelope";
import { assistantMessage, cleanForHistory, commandFallbackReply, historySummariser, userMessage, type Summarise } from "./bee-history";
import { memorySummary, memoryTools, type BeeMemory } from "./bee-memory";
import { answerEvidence, guardLine, replaceLastText, runEvidence, type ClaimKind } from "./claim-guard";
import { routeWithJev, type JevRoute } from "./command-route-jev";
import { createRunControl, stopLine, type ComputerPlatform, type RunControl } from "./computer-control";
import { computerTools, type ConfirmRequest } from "./computer-tools";
import { computerAccess, runComputerUse, simpleComputerTask, wantsComputerUse, type ComputerSkills, type ComputerUseResult } from "./computer-use";
import { debugLog, errorData } from "./debug-log";
import { COMMAND_MODEL, GUIDE_MODEL, JEV_MODEL, NO_GATEWAY_KEY, type BeeGateway } from "./gateway";
import type { McpTools } from "./mcp";
import { routeCommand, type DesktopActionResult, type DesktopActions } from "./desktop-actions";
import { desktopTools } from "./desktop-tools";
import { correctedName, nameAmbiguities, screenNames, spelledName, whichNameQuestion } from "./known-names";
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
// When the word rules leave the path open (no quick open, and computer use is there), Jev picks it in one choice question within
// about 300 ms (core/command-route-jev.ts); on a time out or an unsure answer, the word rules decide as before. A simple task on
// screen ("click Inbox") runs first on the fast model with thinking off, and goes to the planning model when it asks to or runs
// out of turns. Bee's memory (core/bee-memory.ts) goes with every request as a short summary, with memory_read and memory_write
// to change it. Jev never ranks notes here: there is no meeting turn to rank them for. Bee's whole history (core/bee-history.ts:
// every earlier request with the AI's text, tool calls and results) goes to the AI before the request, so a follow-up ("the team
// one", "yes") carries on from there.
// Each request's own messages go back to main through onTurn, to be added to that history.

const RETRIEVE_LIMIT = 5;
const GUIDE_NOTE_LIMIT = 3;
const MCP_ERRORS_MAX = 20;
const MCP_ERROR_CHARS = 300;
// Streamed lines over IPC (shared/ipc.ts lunaPartialSchema).
const PARTIAL_MAX = 5;

const FAST_TOOL = { "open-app": "open_app", "focus-app": "focus_window", "open-url": "open_url" } as const;
// A request that does something to or for a person: sending, messaging, inviting, deleting. A name in it must be the right person.
const REACHES_PERSON = /\b(?:send|message|dm|text|e-?mail|mail|reply|respond|post|tell|ping|call|invite|share|forward|delete|remove|add)\b/i;

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
  /** agent-desktop's guides, loaded once for the session over run (core/computer-use.ts computerSkills). */
  skills?: ComputerSkills;
  /** "Ask before sending or deleting", read per action. */
  askFirst: () => boolean;
  /** Shows the Confirm prompt in the island; true for Confirm. */
  confirm: (request: ConfirmRequest, signal: AbortSignal) => Promise<boolean>;
  /** The island's step line ("Clicking Send…"). */
  onStep?: (label: string) => void;
  /** The run's controls, so main can stop it (the Stop button, "Bee, stop"). */
  onControl?: (control: RunControl) => void;
  /** A step limit, for tests. None by default: the loop guard, Stop and the clock end a run. */
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

/**
 * The computer-use loop for one request, ending with one line for the island. On a Mac without Accessibility, or Linux without
 * the AT-SPI bus (agent-desktop reports accessibility denied there), no loop runs: the line says why.
 */
async function runComputerCommand(args: {
  command: string;
  transcript?: string[];
  history?: readonly ModelMessage[];
  host: ComputerHost;
  actions: DesktopActions;
  gateway: BeeGateway;
  signal?: AbortSignal;
  onActivity?: (activity: LunaToolActivity) => void;
  summarise?: Summarise;
  knownNames?: readonly string[];
  /** The run's messages for Bee's history (core/bee-history.ts), without the request. */
  onMessages?: (messages: ModelMessage[]) => void;
  /** Bee's memory: its summary goes with the request, and the AI may read and change it. */
  memory?: BeeMemory | null;
  /** A simple task (simpleComputerTask): the fast model tries it first, and hands it to the planning model when it cannot. */
  fast?: boolean;
}): Promise<PipelineResult> {
  const { host } = args;
  const maxSteps = host.maxSteps;
  const control = createRunControl({ maxSteps, maxMs: host.maxMs, signal: args.signal });
  host.onControl?.(control);
  const started = performance.now();
  // The first step line shows the island's Stop button at once, before the access check.
  host.onStep?.("Starting…");
  try {
    debugLog.info("computer", "run-start", { platform: host.platform, maxSteps: maxSteps ?? null, maxMs: host.maxMs ?? null, askFirst: host.askFirst(), command: args.command });
    if (host.platform === "mac" || host.platform === "linux") {
      const access = await computerAccess(host.run, control.signal);
      debugLog.info("computer", "access", access);
      if (control.reason()) {
        const line = stopLine(control.reason() ?? "user", { platform: host.platform });
        args.onMessages?.([assistantMessage(line)]);
        return lineResult(line);
      }
      if (access.accessibility === "denied") {
        console.debug("perf computer access=denied");
        const line = stopLine("permission", { platform: host.platform });
        args.onMessages?.([assistantMessage(line)]);
        return lineResult(line);
      }
    }
    // Sends, deletes, purchases and submits the confirm gate counted as done: proof for the last line (core/claim-guard.ts).
    const committed = new Set<ClaimKind>();
    const tools = {
      ...computerTools({
        run: host.run,
        desktop: args.actions,
        control,
        platform: host.platform,
        askFirst: host.askFirst,
        confirm: host.confirm,
        onStep: host.onStep,
        onActivity: args.onActivity,
        onEffect: (kind) => committed.add(kind),
      }),
      // Memory changes nothing on screen, so its calls take no step of the run's budget.
      ...(args.memory ? memoryTools(args.memory) : {}),
    };
    const remembered = args.memory ? memorySummary(args.memory.facts()) : "";
    const base = {
      command: args.command,
      transcript: args.transcript,
      history: args.history,
      summarise: args.summarise,
      ...(args.knownNames?.length ? { knownNames: args.knownNames } : {}),
      ...(remembered ? { memory: remembered } : {}),
      tools,
      control,
      platform: host.platform,
      ...(maxSteps !== undefined ? { maxSteps } : {}),
      ...(host.skills ? { skills: host.skills } : {}),
    };
    // The fast model tries a simple task first. When it hands over, the planning model carries on from its steps, with the same
    // control (the same refs, budget, clock and Stop).
    let outcome: ComputerUseResult;
    const quick = args.fast ? await runComputerUse({ ...base, model: args.gateway.languageModel(GUIDE_MODEL), fast: true }) : null;
    if (quick && !quick.escalate) outcome = quick;
    else {
      if (quick) console.debug(`perf computer fast escalate steps=${quick.steps}`);
      const planned = await runComputerUse({ ...base, model: args.gateway.languageModel(COMMAND_MODEL), ...(quick?.messages.length ? { steps: quick.messages } : {}) });
      outcome = quick ? { ...planned, messages: [...quick.messages, ...planned.messages] } : planned;
    }
    const guide = performance.now() - started;
    // A line that claims a send, delete, purchase or submit this run never proved, or an empty calendar no read showed, becomes a
    // cautious one. A stop or an error already has its own line.
    if (!outcome.stopped && !outcome.error) {
      const checked = guardLine(outcome.line, runEvidence(outcome.messages, committed));
      if (checked.rewritten) {
        debugLog.warn("computer", "claim-rewritten", { line: outcome.line, shown: checked.line, reason: checked.reason, proven: [...committed] });
        // The history keeps the line the user saw in place of the claim, so no later turn reads the claim as Bee's own.
        outcome = { ...outcome, line: checked.line, claimRewritten: true, messages: replaceLastText(outcome.messages, checked.line) };
      }
    }
    debugLog.info("computer", "run-end", { ...outcome, reason: control.reason(), declined: control.declined(), ms: Math.round(guide) });
    // What the AI did, tool calls and results included, then the line the island shows when it differs (a stop).
    const said = outcome.messages.length > 0 && !outcome.stopped && !outcome.error ? outcome.messages : [...outcome.messages, assistantMessage(outcome.line)];
    args.onMessages?.(said);
    const where = outcome.endedWhere ? { endedWhere: outcome.endedWhere } : {};
    if (outcome.error) return { ...lineResult(outcome.line, { guide, lunaTotal: guide }), tips: [], tipSources: [], guideError: outcome.line, ...where };
    return { ...lineResult(outcome.line, { guide, lunaTotal: guide }), ...where };
  } finally {
    control.dispose();
  }
}

/**
 * Whether a request (after no quick open matched) goes to the computer-use loop. Jev decides when it answers in time and is sure
 * (computer_use or direct_answer); otherwise, and for any other route it gives, the word rules do (wantsComputerUse). A request
 * Jev calls an open, focus or page was not one routeCommand could name, so the word rules take that too.
 */
async function wantsLoop(command: string, gateway: BeeGateway, signal?: AbortSignal): Promise<boolean> {
  const words = wantsComputerUse(command);
  // Test and replay gateways may have no evaluation model: the word rules alone, then.
  if (typeof gateway.evaluationModel !== "function") return words;
  let route: JevRoute | null = null;
  try {
    route = await routeWithJev({ model: gateway.evaluationModel(JEV_MODEL), command, ...(signal ? { signal } : {}) });
  } catch (error) {
    debugLog.info("ai", "jev-route-failed", { error: errorData(error) });
  }
  const loop = route === "computer_use" ? true : route === "direct_answer" ? false : words;
  debugLog.info("ai", "command-path", { jev: route, words, loop });
  return loop;
}

export async function runDirectCommand(args: {
  /** The request after the wake word: "open Teams", "what's 15% of 18000?". */
  command: string;
  /** The latest meeting lines, as background for a request about the meeting. Never answered as tips. */
  transcript?: string[];
  /** Bee's history (core/bee-history.ts), oldest first: every earlier turn, sent whole to the AI. */
  history?: readonly ModelMessage[];
  /** Called once with this request's messages (the request, the AI's text, tool calls and results), cleaned for the history. */
  onTurn?: (messages: ModelMessage[]) => void;
  /** Names Bee should know (core/known-names.ts), for the AI. */
  knownNames?: readonly string[];
  /** Names learned from this request: a spelling the user gave, chat names read on screen. Main adds them to Settings. */
  onLearnNames?: (names: string[]) => void;
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
  /** Bee's memory (main/bee-memory-store.ts). Absent: the AI has no memory tools and no summary. */
  memory?: BeeMemory | null;
}): Promise<PipelineResult> {
  const command = args.command.replace(/\s+/g, " ").trim();
  const route = routeCommand(command);
  const history = args.history ?? [];
  let recorded = false;
  const record = (messages: readonly ModelMessage[]) => {
    if (recorded) return;
    recorded = true;
    const turn = cleanForHistory([userMessage(command), ...messages]);
    args.onTurn?.(turn);
    // Names to keep: a spelling or a correction the user just gave ("I meant Krzysztof"), and chat names in the tool results and
    // the AI's reply. A correction teaches the spelling only: Bee never stores that one name means another.
    const said = [spelledName(command), correctedName(command)].filter((name): name is string => name !== null);
    const learned = [...said, ...screenNames(JSON.stringify(turn.slice(1)).replace(/\\"/g, '"'))];
    if (learned.length > 0) {
      debugLog.info("ai", "names-learned", { names: learned });
      args.onLearnNames?.(learned);
    }
  };
  // Near the window, the oldest messages fold into a summary written by the fast model (core/bee-history.ts).
  const gateway = args.gateway;
  const summarise: Summarise | undefined = gateway ? (messages, signal) => historySummariser(gateway.languageModel(GUIDE_MODEL))(messages, signal) : undefined;
  debugLog.info("ai", "command-route", { command, route, history: history.length, computer: Boolean(args.computer), desktop: Boolean(args.actions), wantsComputer: wantsComputerUse(command) });
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
    // The quick action as a real tool call and result, like the AI's own, so the next request sees what was done.
    const toolCallId = `bee_fast_${Date.now().toString(36)}`;
    const input = route.kind === "open-url" ? { url: route.url } : route.kind === "open-app" ? { name: route.name } : { app: route.name };
    record([
      { role: "assistant", content: [{ type: "tool-call", toolCallId, toolName: tool, input }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId, toolName: tool, output: { type: "text", value: result.message } }] },
      assistantMessage(result.message),
    ]);
    console.debug(`perf command fast ${route.kind} ok=${result.ok ? 1 : 0}`);
    return { notes: [], rankSource: "fallback", rankError: null, tips: [result.message], tipSources: [null], sources: [], guideError: null, actions: [result.message], timingsMs: timings() };
  }

  // A message, a send or a delete for a name that could be more than one person the user has taught Bee ("Chris": Chris Lee or
  // Krzysztof Nowak) asks which one first, before any AI call or action: never a silent pick. The answer is a follow-up.
  const unclear = REACHES_PERSON.test(command) ? nameAmbiguities(command, args.knownNames ?? [])[0] : undefined;
  if (unclear) {
    const question = whichNameQuestion(unclear);
    debugLog.info("ai", "name-ambiguous", { command, heard: unclear.heard, matches: unclear.matches });
    record([assistantMessage(question)]);
    return lineResult(question);
  }

  // A task on screen goes straight to the loop: it needs no notes, connectors or web search.
  const computer = args.computer && args.actions && args.gateway ? { host: args.computer, actions: args.actions, gateway: args.gateway } : null;
  const memory = args.memory ?? null;
  const loop = (fast = false) =>
    computer
      ? runComputerCommand({ ...computer, command, transcript: args.transcript, history, signal: args.signal, onActivity: args.onActivity, summarise, knownNames: args.knownNames, onMessages: record, memory, fast })
      : Promise.reject(new Error("no computer use"));
  if (computer && (await wantsLoop(command, computer.gateway, args.signal))) {
    console.debug("perf command computer");
    return loop(simpleComputerTask(command));
  }

  const t0 = performance.now();
  const retrieved = retrieve(command, args.snippets, RETRIEVE_LIMIT, args.meetingTerms);
  const candidates = retrieved.map(({ snippet, score }) => ({ ...snippet, retrieveScore: score }));
  const retrieveMs = performance.now() - t0;
  const guideNotes = candidates.slice(0, GUIDE_NOTE_LIMIT);
  const notes = candidates.map((note, index) => ({ ...note, jevScore: null, cite: index < GUIDE_NOTE_LIMIT ? noteCitation(index) : null }));
  if (!args.gateway) {
    record([assistantMessage(`Error: ${NO_GATEWAY_KEY}`)]);
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
  const desktop = args.actions
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
  const tools = desktop || memory ? { ...desktop, ...(memory ? memoryTools(memory) : {}) } : undefined;
  const started = performance.now();
  const guide = await guideWithLuna({
    model: args.gateway.languageModel(COMMAND_MODEL),
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
    historyMessages: history,
    summarise,
    knownNames: args.knownNames,
    ...(memory ? { memory: memorySummary(memory.facts()) } : {}),
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
  // No reply and no action (NONE, or no text at all) never leaves the island blank: a short line or a question back instead.
  const silent = actionLines.length === 0 && guide.tips.length === 0 && !guide.loop && (guide.error === null || guide.empty === true);
  if (silent) debugLog.info("ai", "command-fallback", { command, empty: guide.empty ?? false });
  // An answer has no computer tools: a line that says something was sent or deleted needs a tool result that succeeded this turn
  // (a connector may have done it), or an earlier turn that proved or showed it ("did you send it?"); "no meetings" needs a read
  // that succeeded when tools were tried (core/claim-guard.ts).
  const evidence = answerEvidence(guide.messages ?? [], history);
  const checkedTips = guide.tips.map((tip) => guardLine(tip, evidence, { requireProof: false }));
  const rewritten = checkedTips.filter((checked) => checked.rewritten);
  if (rewritten.length > 0) debugLog.warn("ai", "claim-rewritten", { tips: guide.tips, shown: checkedTips.map((checked) => checked.line), reasons: rewritten.map((checked) => checked.reason) });
  // A replaced line keeps no source label: the label belonged to the claim.
  const reply: TipFields = { tips: checkedTips.map((checked) => checked.line), tipSources: guide.tipSources.map((source, index) => (checkedTips[index]?.rewritten ? null : source)) };
  const shown = silent ? { tips: [commandFallbackReply(command)], tipSources: [null] } : joinLines(actionLines, reply);
  // The AI's own messages, then what the island showed when the AI wrote nothing (a fallback, a stop or an error).
  const shownText = shown.tips.join("\n");
  const lastText = guide.messages?.at(-1)?.role === "assistant" && guide.tips.length > 0;
  const closing = lastText ? [] : [assistantMessage(guide.error && !silent ? `${shownText ? `${shownText}\n` : ""}Error: ${guide.error}` : shownText || "(no reply)")];
  // A replaced claim leaves the history too: it keeps the lines the user saw.
  record(rewritten.length > 0 ? replaceLastText(guide.messages ?? [], shownText) : [...(guide.messages ?? []), ...closing]);
  return {
    notes,
    rankSource: "fallback",
    rankError: null,
    ...shown,
    sources: guide.sources,
    ...(actionLines.length > 0 ? { actions: actionLines.slice(0, 10) } : {}),
    // After an action, no further text is a fine end: the action line is the answer.
    guideError: silent || (guide.empty && actionLines.length > 0) ? null : guide.error,
    guideNote: guide.skipped,
    mcpErrors: (mcp?.errors ?? []).slice(0, MCP_ERRORS_MAX).map(({ server, error }) => ({ server: server.slice(0, 200), error: error.slice(0, MCP_ERROR_CHARS) })),
    timingsMs: timings({ retrieve: retrieveMs, mcp: mcpMs, guide: guideMs, lunaFirstToken: guide.firstTokenMs, lunaTotal: guide.totalMs }),
  };
}
