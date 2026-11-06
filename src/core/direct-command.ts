import { tool, type ModelMessage } from "ai";
import { z } from "zod";
import type { PipelineResult } from "../shared/ipc";
import type { ComputerRun } from "./agent-desktop-envelope";
import { assistantMessage, cleanForHistory, commandFallbackReply, historySummariser, userMessage, type Summarise } from "./bee-history";
import { memorySummary, memoryTools, type BeeMemory } from "./bee-memory";
import { answerEvidence, guardLine, replaceLastText, runEvidence, upgradeLine, withoutToolNames, type ClaimKind } from "./claim-guard";
import { clarifyingQuestion } from "./clarify";
import { routeWithJev, type JevRoute } from "./command-route-jev";
import { createRunControl, stopLine, type ComputerPlatform, type RunControl } from "./computer-control";
import { computerTools, type ConfirmRequest } from "./computer-tools";
import { computerAccess, runComputerUse, shortComputerTask, simpleComputerTask, wantsComputerUse, type ComputerSkills, type ComputerUseResult } from "./computer-use";
import { debugLog, errorData, msSince } from "./debug-log";
import { COMMAND_MODEL, GUIDE_MODEL, JEV_MODEL, NO_GATEWAY_KEY, type BeeGateway } from "./gateway";
import type { McpTools } from "./mcp";
import { isKnownApp, routeCommand, type DesktopActionResult, type DesktopActions } from "./desktop-actions";
import { desktopTools } from "./desktop-tools";
import { correctedName, nameAmbiguities, recentChoice, screenNames, similarityChoice, spelledName, type ResolvedName } from "./known-names";
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
// A request that does something to or for a person: sending, messaging, calling, inviting, deleting, or finding or opening their
// chat ("open chris's chat", "find krzys", "chat with Chris"). A name in it must be the right person. Any case: speech-to-text may
// write "send chris a message". An app ("open Chrome") never asks: nameAmbiguities skips app words, and runDirectCommand known apps.
const REACHES_PERSON =
  /\b(?:send|message|dm|text|e-?mail|mail|reply|respond|post|tell|ping|call|ring|phone|invite|share|forward|delete|remove|add|open|find|show|search|look\s+up|chat|talk|with|to|cc)\b|['’]s\s+(?:chat|dm|messages?|thread|conversation|inbox)\b/i;
// How many of the user's latest requests count as recent, for a person they meant (core/known-names.ts recentChoice).
const RECENT_TURNS = 3;
// Tool timings kept for one request's timing log.
const TOOL_TIMES_MAX = 40;
// Accessibility that agent-desktop reported granted, by computer-use runner: not asked again for this long (each ask is an
// agent-desktop process on the path to the first step). A permission refusal during a run forgets it at once.
const ACCESS_TTL_MS = 5 * 60_000;
const accessGranted = new WeakMap<ComputerRun, number>();

/**
 * Text from the user's last RECENT_TURNS requests, oldest first: their words, the AI's text and its tool inputs (a name typed in a
 * search box). Never tool results: a contact list or a chat list names everyone.
 */
export function recentTexts(history: readonly ModelMessage[], turns = RECENT_TURNS): string[] {
  let start = history.length;
  let users = 0;
  for (let index = history.length - 1; index >= 0 && users < turns; index -= 1) {
    if (history[index]?.role !== "user") continue;
    users += 1;
    start = index;
  }
  const texts: string[] = [];
  for (const message of history.slice(start)) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (typeof message.content === "string") {
      texts.push(message.content);
      continue;
    }
    for (const part of message.content) {
      if (part.type === "text") texts.push(part.text);
      else if (part.type === "tool-call") texts.push(JSON.stringify(part.input));
    }
  }
  return texts;
}

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
  /** Names in the request Bee settled from the user's recent requests (core/known-names.ts recentChoice). */
  resolvedNames?: readonly ResolvedName[];
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
    const granted = accessGranted.get(host.run);
    if ((host.platform === "mac" || host.platform === "linux") && granted !== undefined && performance.now() - granted < ACCESS_TTL_MS) {
      debugLog.info("computer", "access", { accessibility: "granted", cached: true });
    } else if (host.platform === "mac" || host.platform === "linux") {
      const access = await computerAccess(host.run, control.signal);
      debugLog.info("computer", "access", access);
      if (access.accessibility === "granted") accessGranted.set(host.run, performance.now());
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
      ...(args.resolvedNames?.length ? { resolvedNames: args.resolvedNames } : {}),
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
      // A short task (one target, no later step) thinks at low effort: each step is a plain look or act.
      const effort = shortComputerTask(args.command) ? "low" : "medium";
      const planned = await runComputerUse({ ...base, model: args.gateway.languageModel(COMMAND_MODEL), effort, ...(quick?.messages.length ? { steps: quick.messages } : {}) });
      outcome = quick ? { ...planned, messages: [...quick.messages, ...planned.messages] } : planned;
    }
    if (control.reason() === "permission") accessGranted.delete(host.run);
    const guide = performance.now() - started;
    // The model's first reply: the fast pass's when it ran first.
    const firstStep = quick?.firstStepMs ?? outcome.firstStepMs ?? null;
    // A line that claims a send, delete, purchase or submit this run never proved, or an empty calendar no read showed, becomes a
    // cautious one. A stop or an error already has its own line.
    if (!outcome.stopped && !outcome.error) {
      const evidence = runEvidence(outcome.messages, committed);
      const checked = guardLine(outcome.line, evidence);
      // The other way round: a line that doubts a send, delete, purchase or submit the gate counted as done (and the message box
      // check did not contradict) says it plainly. "Bee could not confirm the send went through" after a confirmed Send → Sent.
      const upgraded = checked.rewritten ? null : upgradeLine(outcome.line, committed, evidence.typed);
      if (checked.rewritten) {
        debugLog.warn("computer", "claim-rewritten", { line: outcome.line, shown: checked.line, reason: checked.reason, proven: [...committed] });
        // The history keeps the line the user saw in place of the claim, so no later turn reads the claim as Bee's own.
        outcome = { ...outcome, line: checked.line, claimRewritten: true, messages: replaceLastText(outcome.messages, checked.line) };
      } else if (upgraded?.upgraded) {
        debugLog.info("computer", "claim-upgraded", { line: outcome.line, shown: upgraded.line, kind: upgraded.kind, proven: [...committed] });
        outcome = { ...outcome, line: upgraded.line, messages: replaceLastText(outcome.messages, upgraded.line) };
      }
    }
    // Never a tool name, a ref or an agent-desktop code in what the user reads ("…never appeared after open_app").
    const plain = withoutToolNames(outcome.line);
    if (plain !== outcome.line) {
      debugLog.info("computer", "line-plain", { line: outcome.line, shown: plain });
      const said = outcome.messages.length > 0 && !outcome.stopped && !outcome.error;
      outcome = { ...outcome, line: plain, ...(said ? { messages: replaceLastText(outcome.messages, plain) } : {}) };
    }
    debugLog.info("computer", "run-end", { ...outcome, reason: control.reason(), declined: control.declined(), ms: Math.round(guide) });
    // What the AI did, tool calls and results included, then the line the island shows when it differs (a stop).
    const said = outcome.messages.length > 0 && !outcome.stopped && !outcome.error ? outcome.messages : [...outcome.messages, assistantMessage(outcome.line)];
    args.onMessages?.(said);
    const where = outcome.endedWhere ? { endedWhere: outcome.endedWhere } : {};
    const times = { guide, lunaTotal: guide, lunaFirstToken: firstStep };
    if (outcome.error) return { ...lineResult(outcome.line, times), tips: [], tipSources: [], guideError: outcome.line, ...where };
    return { ...lineResult(outcome.line, times), ...where };
  } finally {
    control.dispose();
  }
}

/** The path a request took and what chose it: the word rules, Jev's answer (null for none in time), or Jev not asked. */
type PathChoice = { loop: boolean; words: boolean; jev: JevRoute | null | "skipped"; ms: number };

/**
 * Whether a request (after no quick open matched) goes to the computer-use loop. Jev decides when it answers in time and is sure
 * (computer_use or direct_answer); otherwise, and for any other route it gives, the word rules do (wantsComputerUse). A request
 * Jev calls an open, focus or page was not one routeCommand could name, so the word rules take that too. One clear action on
 * screen ("click Inbox", "press escape": simpleComputerTask) is the loop by the word rules alone: Jev is not asked, which saves
 * its wait (up to ROUTE_TIMEOUT_MS) on the quickest requests.
 */
async function wantsLoop(command: string, gateway: BeeGateway, signal?: AbortSignal): Promise<PathChoice> {
  const started = performance.now();
  const words = wantsComputerUse(command);
  // Test and replay gateways may have no evaluation model: the word rules alone, then.
  if (typeof gateway.evaluationModel !== "function" || simpleComputerTask(command)) {
    const choice: PathChoice = { loop: words, words, jev: "skipped", ms: msSince(started) };
    debugLog.info("ai", "command-path", choice);
    return choice;
  }
  let route: JevRoute | null = null;
  try {
    route = await routeWithJev({ model: gateway.evaluationModel(JEV_MODEL), command, ...(signal ? { signal } : {}) });
  } catch (error) {
    debugLog.info("ai", "jev-route-failed", { error: errorData(error) });
  }
  const choice: PathChoice = { loop: route === "computer_use" ? true : route === "direct_answer" ? false : words, words, jev: route, ms: msSince(started) };
  debugLog.info("ai", "command-path", choice);
  return choice;
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
  // Timing for the local debug log (command-timing): the path choice, the model's first reply, each tool, the whole request.
  // Speech-to-text runs before this, in its own call (stt result).
  const commandStarted = performance.now();
  const toolTimes: { tool: string; ms: number }[] = [];
  const toolStarts = new Map<string, number[]>();
  const onActivity = (activity: LunaToolActivity) => {
    if (activity.phase === "start") toolStarts.set(activity.tool, [...(toolStarts.get(activity.tool) ?? []), performance.now()]);
    else {
      const at = toolStarts.get(activity.tool)?.shift();
      if (at !== undefined && toolTimes.length < TOOL_TIMES_MAX) toolTimes.push({ tool: activity.tool, ms: msSince(at) });
    }
    args.onActivity?.(activity);
  };
  let path: PathChoice | null = null;
  const finish = (kind: string, result: PipelineResult): PipelineResult => {
    const total = msSince(commandStarted);
    const timingsMs = { ...result.timingsMs, ...(path ? { route: path.ms } : {}), total };
    debugLog.info("ai", "command-timing", {
      path: kind,
      totalMs: total,
      routeMs: path?.ms ?? null,
      jev: path?.jev ?? null,
      firstTokenMs: result.timingsMs.lunaFirstToken === null ? null : Math.round(result.timingsMs.lunaFirstToken),
      guideMs: Math.round(result.timingsMs.guide),
      mcpMs: Math.round(result.timingsMs.mcp),
      tools: toolTimes,
    });
    return { ...result, timingsMs };
  };
  if (route.kind !== "ai" && args.actions) {
    const tool = FAST_TOOL[route.kind];
    const actions = args.actions;
    onActivity({ tool, phase: "start" });
    let result: DesktopActionResult;
    try {
      result = await (route.kind === "open-url" ? actions.openUrl(route.url) : route.kind === "open-app" ? actions.openApp(route.name, args.signal) : actions.focusWindow({ app: route.name }, args.signal));
    } catch (error) {
      debugLog.warn("desktop", "action-failed", { route, error: errorData(error) });
      result = { ok: false, message: "That desktop action failed" };
    } finally {
      onActivity({ tool, phase: "end" });
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
    return finish("fast", { notes: [], rankSource: "fallback", rankError: null, tips: [result.message], tipSources: [null], sources: [], guideError: null, actions: [result.message], timingsMs: timings() });
  }

  // A message, a send, a call or a chat for a name that could be more than one person the user has taught Bee ("Chris": Chris Lee
  // or Krzysztof Nowak) asks which one first, before any AI call or action: never a silent pick. The answer is a follow-up. When
  // the user's last few requests were about one of them, that one is meant, and the AI is told so (nothing is stored).
  const ambiguous = nameAmbiguities(command, args.knownNames ?? []).filter((item) => !isKnownApp(item.heard));
  const recent = ambiguous.length > 0 ? recentTexts(history) : [];
  // The heard word first: a literal short form that only sounds like the other ("Krzys": Krzysztof, not Chris) is settled by
  // similarity, and recent text never overrides it. Only a tie goes to recent text, then to a question.
  const bySimilarity: ResolvedName[] = ambiguous.flatMap((item) => {
    const name = similarityChoice(item, args.knownNames ?? []);
    return name ? [{ heard: item.heard, name }] : [];
  });
  if (bySimilarity.length > 0) debugLog.info("ai", "name-similar", { command, resolved: bySimilarity });
  const byRecent: ResolvedName[] = ambiguous.flatMap((item) => {
    if (bySimilarity.some((done) => done.heard === item.heard)) return [];
    const name = recentChoice(item, recent);
    return name ? [{ heard: item.heard, name }] : [];
  });
  if (byRecent.length > 0) debugLog.info("ai", "name-recent", { command, resolved: byRecent });
  const resolvedNames: ResolvedName[] = [...bySimilarity, ...byRecent];
  const unclear = REACHES_PERSON.test(command) ? ambiguous.find((item) => !resolvedNames.some((done) => done.heard === item.heard)) : undefined;
  if (unclear) {
    // One question for everything missing (which person, which app, what to say), so the answer needs no second question. An
    // app named in the user's recent requests or in Bee's memory counts as named.
    const context = [...recent, ...(args.memory?.facts().map((fact) => fact.text) ?? [])];
    const question = clarifyingQuestion({ command, ambiguity: unclear, context });
    debugLog.info("ai", "name-ambiguous", { command, heard: unclear.heard, matches: unclear.matches, question });
    record([assistantMessage(question)]);
    return finish("which-name", lineResult(question));
  }
  const names = resolvedNames.length > 0 ? { resolvedNames } : {};

  // A task on screen goes straight to the loop: it needs no notes, connectors or web search.
  const computer = args.computer && args.actions && args.gateway ? { host: args.computer, actions: args.actions, gateway: args.gateway } : null;
  const memory = args.memory ?? null;
  const loop = async (fast = false) =>
    computer
      ? finish(
          "computer",
          await runComputerCommand({ ...computer, command, transcript: args.transcript, history, signal: args.signal, onActivity, summarise, knownNames: args.knownNames, ...names, onMessages: record, memory, fast }),
        )
      : Promise.reject(new Error("no computer use"));
  // While Jev picks the path, connectors load beside it (as in the meeting pipeline), so the answer path does not wait for them
  // after Jev. The loop does not use them: they close at once.
  let mcpStarted = performance.now();
  let mcpLoad: Promise<McpTools | null> | null = null;
  if (computer) {
    const asksJev = typeof computer.gateway.evaluationModel === "function" && !simpleComputerTask(command);
    if (asksJev) mcpLoad = loadMcp(args.loadMcpTools);
    path = await wantsLoop(command, computer.gateway, args.signal);
    if (path.loop) {
      void mcpLoad?.then((loaded) => loaded?.close()).catch(() => undefined);
      console.debug("perf command computer");
      return loop(simpleComputerTask(command));
    }
  }

  const t0 = performance.now();
  const retrieved = retrieve(command, args.snippets, RETRIEVE_LIMIT, args.meetingTerms);
  const candidates = retrieved.map(({ snippet, score }) => ({ ...snippet, retrieveScore: score }));
  const retrieveMs = performance.now() - t0;
  const guideNotes = candidates.slice(0, GUIDE_NOTE_LIMIT);
  const notes = candidates.map((note, index) => ({ ...note, jevScore: null, cite: index < GUIDE_NOTE_LIMIT ? noteCitation(index) : null }));
  if (!args.gateway) {
    record([assistantMessage(`Error: ${NO_GATEWAY_KEY}`)]);
    return finish("no-key", { notes, rankSource: "fallback", rankError: NO_GATEWAY_KEY, tips: [], tipSources: [], sources: [], guideError: NO_GATEWAY_KEY, timingsMs: timings({ retrieve: retrieveMs }) });
  }

  if (!mcpLoad) {
    mcpStarted = performance.now();
    mcpLoad = loadMcp(args.loadMcpTools);
  }
  const mcp = await mcpLoad;
  // From the start of the load. When it ran beside Jev, the part Jev covered was no extra wait.
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
    ...names,
    ...(memory ? { memory: memorySummary(memory.facts()) } : {}),
    onActivity,
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
  // An answer has no computer tools: a line that says something was sent or deleted needs proof of that kind, from this turn (a
  // connector whose own name says it sends or deletes, and that succeeded) or an earlier turn that proved or showed it ("did you
  // send it?"). An open_app, a list or a web search that succeeded proves nothing. "No meetings" needs a calendar read that
  // succeeded when a calendar tool was tried (core/claim-guard.ts).
  const evidence = answerEvidence(guide.messages ?? [], history);
  const checkedTips = guide.tips.map((tip) => guardLine(tip, evidence));
  const rewritten = checkedTips.filter((checked) => checked.rewritten);
  if (rewritten.length > 0) debugLog.warn("ai", "claim-rewritten", { tips: guide.tips, shown: checkedTips.map((checked) => checked.line), reasons: rewritten.map((checked) => checked.reason) });
  // A replaced line keeps no source label: the label belonged to the claim. No line names a tool, a ref or an agent-desktop
  // code (core/claim-guard.ts withoutToolNames): plain words instead, its label kept.
  const reply: TipFields = {
    tips: checkedTips.map((checked) => withoutToolNames(checked.line)),
    tipSources: guide.tipSources.map((source, index) => (checkedTips[index]?.rewritten ? null : source)),
  };
  const shown = silent ? { tips: [commandFallbackReply(command)], tipSources: [null] } : joinLines(actionLines, reply);
  // The AI's own messages, then what the island showed when the AI wrote nothing (a fallback, a stop or an error).
  const shownText = shown.tips.join("\n");
  const lastText = guide.messages?.at(-1)?.role === "assistant" && guide.tips.length > 0;
  const closing = lastText ? [] : [assistantMessage(guide.error && !silent ? `${shownText ? `${shownText}\n` : ""}Error: ${guide.error}` : shownText || "(no reply)")];
  // A replaced claim leaves the history too: it keeps the lines the user saw.
  record(rewritten.length > 0 ? replaceLastText(guide.messages ?? [], shownText) : [...(guide.messages ?? []), ...closing]);
  return finish("answer", {
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
  });
}
