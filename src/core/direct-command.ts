import type { PipelineResult } from "../shared/ipc";
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
// the user, not the meeting. "Open <a known app>" and "open <a web address>" run at once with no AI call; anything else goes
// to Luna with the desktop tools. The result has the pipeline's shape, so the island shows it like tips: action lines first
// ("Opened Teams"), then the reply. No Jev: there is no meeting turn to rank notes for.

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
  onActivity?: (activity: LunaToolActivity) => void;
  onPartial?: (partial: TipFields) => void;
  signal?: AbortSignal;
}): Promise<PipelineResult> {
  const command = args.command.replace(/\s+/g, " ").trim();
  const route = routeCommand(command);
  if (route.kind !== "ai" && args.actions) {
    const tool = FAST_TOOL[route.kind];
    const actions = args.actions;
    args.onActivity?.({ tool, phase: "start" });
    let result: DesktopActionResult;
    try {
      result = await (route.kind === "open-url" ? actions.openUrl(route.url) : route.kind === "open-app" ? actions.openApp(route.name) : actions.focusWindow({ app: route.name }));
    } catch {
      result = { ok: false, message: "That desktop action failed" };
    } finally {
      args.onActivity?.({ tool, phase: "end" });
    }
    console.debug(`perf command fast ${route.kind} ok=${result.ok ? 1 : 0}`);
    return { notes: [], rankSource: "fallback", rankError: null, tips: [result.message], tipSources: [null], sources: [], guideError: null, timingsMs: timings() };
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
  const tools = args.actions
    ? desktopTools(args.actions, (line) => {
        actionLines.push(line);
        emit();
      })
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
    onActivity: args.onActivity,
    onPartial: (partial) => {
      streamed = partial;
      emit();
    },
    signal: args.signal,
  });
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
