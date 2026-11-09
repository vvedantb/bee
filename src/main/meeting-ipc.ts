import { app, ipcMain, shell } from "electron";
import { z } from "zod";
import type { AutoSignals } from "../core/auto-meeting-detection";
import { NO_SIGNALS } from "../core/meeting-signals";
import { meetingTerms, meetingWindowBrief, type MeetingWindowContext } from "../core/agent-desktop-meeting";
import type { AccessState, ComputerRun } from "../core/agent-desktop-envelope";
import type { ComputerPlatform, RunControl } from "../core/computer-control";
import { computerAccess, computerSkills } from "../core/computer-use";
import { debugLog, errorData, msSince } from "../core/debug-log";
import type { DesktopActions } from "../core/desktop-actions";
import { historySummariser } from "../core/bee-history";
import { memoryTools, type BeeMemory } from "../core/bee-memory";
import { BACKGROUND_MAX, createBackgroundJobs } from "../core/background";
import { briefingTask, type Briefing } from "../core/briefing";
import { followThrough, followThroughLines, followThroughTask, type FollowThrough } from "../core/follow-through";
import { CLAUDE_CODE_MISSING, claudeCodeMessage } from "../core/claude-code";
import type { ClaudeCode } from "./claude-code";
import type { ClaudeCodeStatus } from "../core/claude-code";
import type { Browse } from "./browse";

const claudeCodeView = (status: ClaudeCodeStatus): ClaudeCodeView => ({ state: status.state, version: "version" in status ? status.version : null, message: claudeCodeMessage(status) });
import type { CommandAgent } from "../core/claude-agent";
import { runDirectCommand, type ComputerHost } from "../core/direct-command";
import type { ScreenCapture } from "../core/screen-look";
import { classifyFollowUp } from "../core/follow-up";
import { summariseRecap } from "../core/recap";
import { loadMcpTools, type McpPool, type McpServerConfig } from "../core/mcp";
import type { MeetingContext } from "../core/meeting-context";
import { GUIDE_MODEL, NO_GATEWAY_KEY, STT_MODEL, createBeeGateway, type BeeGateway } from "../core/gateway";
import { runPipeline } from "../core/pipeline";
import { searchLocation } from "../core/web-search";
import { conversationTranscript, meetingTranscript } from "../core/session-transcript";
import { buildLocalSummary, generateMeetingSummary } from "../core/summary";
import { sttVocabulary, transcribeSpeech } from "../core/transcribe";
import {
  COMPUTER_LINE_MAX,
  IPC,
  commandRequestSchema,
  commandStopSchema,
  computerAnswerSchema,
  conversationEndedSchema,
  followUpRequestSchema,
  recapRequestSchema,
  meetingContextRequestSchema,
  meetingSummaryRequestSchema,
  pipelineCancelSchema,
  pipelineRequestSchema,
  transcribeRequestSchema,
  cardActionRequestSchema,
  type CardAction,
  type CardActionResult,
  type ClaudeCodeUpdateResult,
  type BrowseInstallResult,
  type BrowseView,
  type BackgroundJobView,
  type ClaudeCodeView,
  type ComputerAccessView,
  type ComputerUpdate,
  type FollowUpResult,
  type RecapResult,
  type LunaActivity,
  type LunaPartial,
  type MeetingSummaryResult,
  type MeetingWindowStatus,
} from "../shared/ipc";
import { assertSignedIn } from "./auth";
import { isNotePath, loadSnippets, writeMeetingSummaryFile } from "./notes";
import type { BeeHistoryStore } from "./bee-history-store";
import type { VmemTranscripts } from "./vmem-transcript-queue";

/**
 * Mic phrases → speech-to-text, lines → retrieve → Jev → Luna, and the end-of-meeting summary into the notes folder.
 * The Gateway key never leaves main.
 */
export function registerMeetingIpc(args: { notesDir: string;
  mcpConfigs: () => McpServerConfig[];
  /** Enabled sign-in servers with no tokens. mcpConfigs leaves them out; Luna is told they are not signed in. */
  mcpSignedOut: () => string[];
  /** Tool lists and warm connections, shared across runs. */
  mcpPool: McpPool;
  /** Which meeting the user is in, its brief for Luna, and the saved meetings. */
  meeting: MeetingContext;
  /** Experimental meeting window reader: the call's name and people (retrieval boost and brief) and its Settings status. */
  /** Signals for automatic meeting detection (main/meeting-signals.ts). Absent: never in a meeting. */
  meetingSignals?: { read: () => Promise<AutoSignals> };
  meetingWindow?: { read: () => Promise<unknown>; context: () => MeetingWindowContext | null; status: () => MeetingWindowStatus };
  gatewayApiKey: () => string | undefined;
  /** The user's Claude Code (main/claude-code.ts), which "Bee, …" requests run on. Absent: only quick opens work. */
  claudeCode?: ClaudeCode;
  /** OpenCode Browse (main/browse.ts): its Settings status and installer. Absent: Settings shows it missing. */
  browse?: Browse;
  /** Builds the Gateway models from the key. Defaults to the real Gateway; the E2E harness records or replays them. */
  gateway?: (apiKey: string) => BeeGateway;
  /** Desktop tools for a direct request ("Bee, open Teams", main/desktop-actions.ts). Without them the AI only answers. */
  desktop?: DesktopActions;
  /**
   * Computer use for a direct request (core/computer-use.ts): its own agent-desktop runner, never the meeting window reader's.
   * Absent: Bee cannot operate apps here (Linux, or no agent-desktop).
   */
  computer?: { platform: ComputerPlatform; run: ComputerRun; cleanup: () => void };
  /** Finished sessions to vmem (main/vmem-transcript-queue.ts). It checks the setting and the connector itself. */
  transcripts?: VmemTranscripts;
  /** Bee's history of direct requests on disk (main/bee-history-store.ts). Absent: each request starts with none. */
  history?: BeeHistoryStore;
  /** Bee's memory (main/bee-memory-store.ts): the memory folder in the user data folder. Absent: no memory tools. */
  memory?: BeeMemory;
  /** Names Bee should know (Settings, core/known-names.ts), read per request, and the names a request taught it. */
  knownNames?: () => string[];
  learnNames?: (names: string[]) => void;
  /** Briefings shown before meetings (main/briefing-watcher.ts), by key, for "Dig deeper". */
  briefings?: (key: string) => Briefing | undefined;
  /** look_at_screen's picture of the front window (main/screen-capture.ts). Absent: no look_at_screen tool. */
  look?: ScreenCapture;
  /** macOS Screen Recording for Bee itself, for Settings (look_at_screen). Absent: as agent-desktop reports it. */
  screenRecording?: () => AccessState }): void {
  const createGateway = args.gateway ?? createBeeGateway;
  // One controller per run in flight. The renderer cancels a run when a newer line supersedes it.
  const runs = new Map<string, AbortController>();
  // Computer use in flight, by run id (Stop), its open Confirm prompts by id, and how many runs use the runner now.
  const controls = new Map<string, RunControl>();
  const confirms = new Map<number, { runId: string; resolve: (confirmed: boolean) => void }>();
  let confirmSeq = 0;
  let computerRuns = 0;
  // agent-desktop's guides, read once over the computer-use runner and kept for the app's session.
  const skills = args.computer ? computerSkills(args.computer.run) : undefined;
  /** The agent for a "Bee, …" request on the user's Claude Code, or what the user must do first. */
  const commandAgent = async (): Promise<{ agent: CommandAgent | null; noAgent?: string }> => {
    if (!args.claudeCode) return { agent: null };
    const found = await args.claudeCode.agent();
    return "agent" in found ? { agent: found.agent } : { agent: null, noAgent: found.error };
  };

  // Background tasks (core/background.ts): updates go to the window that last sent a request.
  let lastSender: { isDestroyed: () => boolean; send: (channel: string, payload: unknown) => void } | null = null;
  const background = createBackgroundJobs({
    agent: async () => {
      const got = await commandAgent();
      return got.agent ? { agent: got.agent } : { error: got.noAgent ?? CLAUDE_CODE_MISSING };
    },
    tools: () => (args.memory ? memoryTools(args.memory) : {}),
    history: () => args.history?.messages() ?? [],
    onUpdate: (job) => {
      debugLog.info("ai", "background-update", { id: job.id, status: job.status, tool: job.tool });
      if (lastSender && !lastSender.isDestroyed()) lastSender.send(IPC.backgroundUpdate, job satisfies BackgroundJobView);
    },
    onTurn: (turn) => void args.history?.append(turn),
  });

  ipcMain.handle(IPC.stopBackground, (_event, payload) => {
    background.stop(z.string().max(100).parse(payload));
  });

  // Saved meetings with action items, by summary path, for the follow-up card's buttons. The newest few only.
  const followThroughs = new Map<string, FollowThrough>();
  const FOLLOW_THROUGHS_KEPT = 5;

  /** The background task behind a card's button, or null when Bee no longer has that meeting. */
  function cardJob(action: CardAction): { title: string; task: string } | null {
    if (action.kind === "brief") {
      const briefing = args.briefings?.(action.key);
      return briefing ? briefingTask(briefing) : null;
    }
    const follow = followThroughs.get(action.path);
    return follow ? followThroughTask(action.kind, follow) : null;
  }

  // A button on an island card: "Dig deeper" before a meeting, or a follow-up after one. Each is a background task.
  ipcMain.handle(IPC.cardAction, (event, payload): CardActionResult => {
    const { action, sessionToken } = cardActionRequestSchema.parse(payload);
    assertSignedIn(sessionToken);
    lastSender = event.sender;
    const job = cardJob(action);
    debugLog.info("ai", "card-action", { kind: action.kind, found: job !== null });
    if (!job) return { ok: false, message: "Bee no longer has that meeting. Ask Bee about it instead." };
    const started = background.start(job.title, job.task);
    return started.ok
      ? { ok: true, message: `Started: ${job.title}. Bee shows the result when it is done.` }
      : { ok: false, message: `Bee is already running ${BACKGROUND_MAX} background tasks. Try again when one finishes.` };
  });

  type Sender = { isDestroyed: () => boolean; send: (channel: string, payload: unknown) => void };
  /** Island updates for one request (step lines, Confirm prompts), to the window that asked. */
  const islandSend = (sender: Sender, runId: string | number | undefined) => (update: ComputerUpdate) => {
    if (runId !== undefined && !sender.isDestroyed()) sender.send(IPC.computerUpdate, update);
  };

  /**
   * The island's Confirm prompt for one request, for computer use and browse steps alike. Settled by the island's Confirm or Cancel
   * (computerAnswer), or false once the run stops or the wait times out.
   */
  const islandConfirm = (sender: Sender, runId: string | number | undefined): ComputerHost["confirm"] => {
    const send = islandSend(sender, runId);
    return (request, signal) =>
      new Promise((resolve) => {
        if (runId === undefined) return resolve(false);
        const id = ++confirmSeq;
        const asked = performance.now();
        const settle = (confirmed: boolean, how: "answer" | "closed") => {
          if (!confirms.has(id)) return;
          confirms.delete(id);
          debugLog.info("computer", "confirm-settled", { runId, id, confirmed, how, waitedMs: msSince(asked) });
          resolve(confirmed);
        };
        confirms.set(id, { runId: String(runId), resolve: (confirmed) => settle(confirmed, "answer") });
        // A stop, the 60 s timeout or a newer request: the prompt closes as Cancel.
        signal.addEventListener("abort", () => settle(false, "closed"), { once: true });
        debugLog.info("computer", "confirm-asked", { runId, id, ...request });
        send({ runId, type: "confirm", id, kind: request.kind, question: request.question.slice(0, COMPUTER_LINE_MAX), detail: request.detail.slice(0, COMPUTER_LINE_MAX) });
      });
  };

  /** Main's side of one request's computer use: step lines and Confirm prompts go to the window that asked. */
  const computerHost = (computer: NonNullable<typeof args.computer>, sender: Sender, runId: string | number | undefined, confirm: ComputerHost["confirm"]): ComputerHost => {
    const key = runId === undefined ? null : String(runId);
    const send = islandSend(sender, runId);
    return {
      platform: computer.platform,
      run: computer.run,
      ...(skills ? { skills } : {}),
      onStep: (label) => {
        debugLog.info("computer", "step-line", { runId, label });
        if (runId !== undefined) send({ runId, type: "step", label: label.slice(0, COMPUTER_LINE_MAX) });
      },
      confirm,
      onControl: (control) => {
        if (key !== null) controls.set(key, control);
      },
    };
  };

  /** The runner keeps snapshot refs for a run; once no run uses it, they go. */
  const releaseComputer = () => {
    if (computerRuns === 0) args.computer?.cleanup();
  };

  /** A fresh controller for the run, aborting an older one with the same id. done() forgets it. */
  const track = (runId: string | number | undefined) => {
    const key = runId === undefined ? null : String(runId);
    const controller = new AbortController();
    if (key !== null) {
      runs.get(key)?.abort();
      runs.set(key, controller);
    }
    return { controller, done: () => key !== null && runs.get(key) === controller && runs.delete(key) };
  };

  /** Settings read per run, so changes apply without a restart. Tool lists come from the pool's cache. */
  const mcpTools = async () => {
    const signedOut = args.mcpSignedOut().map((server) => ({ server, error: "not signed in" }));
    const mcp = await loadMcpTools(args.mcpConfigs(), { pool: args.mcpPool });
    return { ...mcp, errors: [...signedOut, ...mcp.errors] };
  };

  ipcMain.handle(IPC.transcribe, (_event, payload) => {
    const request = transcribeRequestSchema.parse(payload);
    assertSignedIn(request.sessionToken);
    const apiKey = args.gatewayApiKey();
    if (!apiKey) {
      debugLog.warn("stt", "no-key", { source: "mic" });
      return { text: null, error: NO_GATEWAY_KEY };
    }
    return transcribeSpeech({ model: createGateway(apiKey).transcription(STT_MODEL), audio: request.audio, source: "mic", vocabulary: sttVocabulary(args.knownNames?.() ?? []) });
  });

  // The meeting context poll runs every few seconds: only a changed view is logged.
  let lastContext = "";

  // The renderer polls this every few seconds. Main steps detection (title and calendar reads are throttled inside). The poll also
  // keeps the meeting window reader going; it never waits for it.
  ipcMain.handle(IPC.meetingContext, async (_event, payload) => {
    const request = meetingContextRequestSchema.parse(payload);
    assertSignedIn(request.sessionToken);
    void args.meetingWindow?.read().catch(() => null);
    const view = await args.meeting.tick();
    const result = args.meetingWindow ? { ...view, reader: args.meetingWindow.status() } : view;
    const seen = JSON.stringify(result);
    if (seen !== lastContext) {
      lastContext = seen;
      debugLog.info("meeting", "context", { ...result, brief: args.meeting.brief() ?? null });
    }
    return result;
  });

  // Automatic meeting detection polls this on the meeting tick. Fails open: a failed read is "no meeting".
  ipcMain.handle(IPC.meetingSignals, async (_event, payload) => {
    assertSignedIn(meetingContextRequestSchema.parse(payload).sessionToken);
    return (await args.meetingSignals?.read().catch(() => null)) ?? NO_SIGNALS;
  });

  ipcMain.handle(IPC.clearMeetingMemory, (_event, payload) => {
    const request = meetingContextRequestSchema.parse(payload);
    assertSignedIn(request.sessionToken);
    const cleared = args.meeting.clearMemory();
    debugLog.info("meeting", "memory-cleared", { cleared });
    return { cleared };
  });

  ipcMain.handle(IPC.runPipeline, async (event, payload) => {
    const request = pipelineRequestSchema.parse(payload);
    assertSignedIn(request.sessionToken);
    const apiKey = args.gatewayApiKey();
    const { controller, done } = track(request.runId);
    const loadStarted = performance.now();
    const snippets = loadSnippets(args.notesDir);
    const loadNotes = performance.now() - loadStarted;
    console.debug(`perf load-notes ${Math.round(loadNotes)}ms`);
    // Names only, from the call window, when the experimental reader is on. Counts are all that goes to the console.
    const windowContext = args.meetingWindow?.context() ?? null;
    if (windowContext) console.debug(`perf meeting-window title=${windowContext.title ? 1 : 0} people=${windowContext.participants.length}`);
    const meetingBrief = [args.meeting.brief(), meetingWindowBrief(windowContext)].filter((part) => part && part.trim()).join("\n") || undefined;
    const started = performance.now();
    debugLog.info("ai", "pipeline-start", {
      runId: request.runId,
      transcript: request.transcript,
      turnLines: request.turnLines,
      shown: request.shown,
      earlier: request.earlier,
      searched: request.searched,
      notes: snippets.length,
      loadNotesMs: Math.round(loadNotes * 10) / 10,
      meetingBrief: meetingBrief ?? null,
      meetingWindow: windowContext,
      hasKey: Boolean(apiKey),
    });
    try {
      const result = await runPipeline({
        transcript: request.transcript,
        shown: request.shown,
        earlier: request.earlier,
        turnLines: request.turnLines,
        searched: request.searched,
        // Read per run, so a time zone change while travelling applies at once.
        searchLocation: searchLocation({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: app.getSystemLocale() }),
        meetingBrief,
        meetingTerms: meetingTerms(windowContext) || undefined,
        snippets,
        gateway: apiKey ? createGateway(apiKey) : null,
        notesDir: args.notesDir,
        // Settings are read now, so changes apply without a restart. Tool lists come from the pool's cache; servers connect on first call.
        loadMcpTools: mcpTools,
        signal: controller.signal,
        onActivity: (activity) => {
          if (!event.sender.isDestroyed()) event.sender.send(IPC.lunaActivity, { runId: request.runId, ...activity } satisfies LunaActivity);
        },
        onPartial: (partial) => {
          if (!controller.signal.aborted && !event.sender.isDestroyed()) event.sender.send(IPC.lunaPartial, { runId: request.runId, ...partial } satisfies LunaPartial);
        },
      });
      debugLog.info("ai", "pipeline-done", { runId: request.runId, ms: msSince(started), cancelled: controller.signal.aborted, ...result });
      return { ...result, timingsMs: { ...result.timingsMs, loadNotes } };
    } catch (error) {
      debugLog.error("ai", "pipeline-failed", { runId: request.runId, ms: msSince(started), cancelled: controller.signal.aborted, error: errorData(error) });
      throw error;
    } finally {
      done();
    }
  });

  // A direct request ("Bee, open Teams", core/direct-command.ts): the reply and desktop action lines for the island. Never a
  // meeting line. The request never goes to the console (the local debug log keeps it).
  ipcMain.handle(IPC.runCommand, async (event, payload) => {
    const request = commandRequestSchema.parse(payload);
    lastSender = event.sender;
    assertSignedIn(request.sessionToken);
    const apiKey = args.gatewayApiKey();
    const { controller, done } = track(request.runId);
    const windowContext = args.meetingWindow?.context() ?? null;
    const meetingBrief = [args.meeting.brief(), meetingWindowBrief(windowContext)].filter((part) => part && part.trim()).join("\n") || undefined;
    const key = request.runId === undefined ? null : String(request.runId);
    const confirm = islandConfirm(event.sender, request.runId);
    const computer = args.computer ? computerHost(args.computer, event.sender, request.runId, confirm) : null;
    if (computer) computerRuns += 1;
    const started = performance.now();
    // Bee's whole history, read from main's copy (the renderer no longer sends one).
    const history = args.history?.messages() ?? [];
    debugLog.info("ai", "command-start", {
      runId: request.runId,
      command: request.command,
      transcript: request.transcript,
      history: history.length,
      meetingBrief: meetingBrief ?? null,
      hasKey: Boolean(apiKey),
      desktop: Boolean(args.desktop),
      computer: computer ? computer.platform : null,
    });
    try {
      const result = await runDirectCommand({
        command: request.command,
        transcript: request.transcript,
        history,
        // Saved after each request, cancelled ones included, so the next request knows what happened.
        onTurn: (turn) => {
          if (!args.history) return;
          void args.history.append(turn, apiKey ? historySummariser(createGateway(apiKey).languageModel(GUIDE_MODEL)) : undefined);
        },
        knownNames: args.knownNames?.(),
        onLearnNames: args.learnNames,
        memory: args.memory ?? null,
        background: background.start,
        meetingBrief,
        meetingTerms: meetingTerms(windowContext) || undefined,
        snippets: loadSnippets(args.notesDir),
        ...(await commandAgent()),
        gateway: apiKey ? createGateway(apiKey) : null,
        notesDir: args.notesDir,
        loadMcpTools: mcpTools,
        actions: args.desktop ?? null,
        computer,
        look: args.look ?? null,
        // A request with no run id has no island prompt to answer: a risky browse step is refused instead.
        confirm: request.runId === undefined ? null : confirm,
        signal: controller.signal,
        onActivity: (activity) => {
          if (!event.sender.isDestroyed()) event.sender.send(IPC.lunaActivity, { runId: request.runId, ...activity } satisfies LunaActivity);
        },
        onPartial: (partial) => {
          if (!controller.signal.aborted && !event.sender.isDestroyed()) event.sender.send(IPC.lunaPartial, { runId: request.runId, ...partial } satisfies LunaPartial);
        },
      });
      debugLog.info("ai", "command-done", { runId: request.runId, ms: msSince(started), cancelled: controller.signal.aborted, ...result });
      return result;
    } catch (error) {
      debugLog.error("ai", "command-failed", { runId: request.runId, ms: msSince(started), error: errorData(error) });
      throw error;
    } finally {
      done();
      if (computer) {
        if (key !== null) controls.delete(key);
        computerRuns -= 1;
        releaseComputer();
      }
    }
  });

  // The conversation window's one small call (core/follow-up.ts): is an unclear own mic phrase for Bee or the meeting? Null
  // without a key, or on any failure, so the phrase stays a meeting line.
  ipcMain.handle(IPC.classifyFollowUp, async (_event, payload): Promise<FollowUpResult> => {
    const request = followUpRequestSchema.parse(payload);
    assertSignedIn(request.sessionToken);
    const apiKey = args.gatewayApiKey();
    if (!apiKey) return null;
    return classifyFollowUp({ model: createGateway(apiKey).languageModel(GUIDE_MODEL), lastBee: request.lastBee, lines: request.lines, phrase: request.phrase, othersQuiet: request.othersQuiet });
  });

  // "What did I miss?" (core/recap.ts): one small call on the missed meeting lines. Null without a key or on any failure, so
  // the renderer lists the lines itself.
  ipcMain.handle(IPC.recapSummary, async (_event, payload): Promise<RecapResult> => {
    const request = recapRequestSchema.parse(payload);
    assertSignedIn(request.sessionToken);
    const apiKey = args.gatewayApiKey();
    if (!apiKey) return null;
    return summariseRecap({ model: createGateway(apiKey).languageModel(GUIDE_MODEL), lines: request.lines });
  });

  // Stop for a direct request: the island's Stop button or "Bee, stop" from the user's own mic. Computer use stops at once (the
  // agent-desktop command in flight is killed) and the request returns "Stopped."; an answer in flight is cancelled.
  ipcMain.handle(IPC.stopCommand, (_event, payload) => {
    const key = String(commandStopSchema.parse(payload).runId);
    const control = controls.get(key);
    debugLog.info("computer", "stop-requested", { runId: key, computer: Boolean(control), running: runs.has(key) });
    if (control) control.stop("user");
    else runs.get(key)?.abort();
  });

  // The island's Confirm or Cancel for an open prompt of that run. Anything else is ignored.
  ipcMain.handle(IPC.computerAnswer, (_event, payload) => {
    const answer = computerAnswerSchema.parse(payload);
    const pending = confirms.get(answer.id);
    const open = pending !== undefined && pending.runId === String(answer.runId);
    debugLog.info("computer", "answer", { ...answer, open });
    if (open) pending.resolve(answer.confirmed);
  });

  // Settings: the user's Claude Code, and what to do when "Bee, …" requests cannot run on it yet.
  ipcMain.handle(IPC.claudeCode, async (_event, payload): Promise<ClaudeCodeView> => {
    if (!args.claudeCode) return { state: "missing", version: null, message: CLAUDE_CODE_MISSING };
    return claudeCodeView(await args.claudeCode.status(z.boolean().catch(false).parse(payload)));
  });

  // Settings → Update Claude Code: `claude update`, then the state now.
  ipcMain.handle(IPC.claudeCodeUpdate, async (): Promise<ClaudeCodeUpdateResult> => {
    if (!args.claudeCode) return { view: { state: "missing", version: null, message: CLAUDE_CODE_MISSING }, error: null };
    const { status, error } = await args.claudeCode.update();
    return { view: claudeCodeView(status), error };
  });

  // Settings: OpenCode Browse, so "Bee, …" requests can use the user's own browser.
  ipcMain.handle(IPC.browse, async (_event, payload): Promise<BrowseView> => {
    if (!args.browse) return { state: "missing" };
    return { state: (await args.browse.status(z.boolean().catch(false).parse(payload))).state };
  });

  // Settings → Install: the official installer, which waits while the user adds the extension; then the state now.
  ipcMain.handle(IPC.browseInstall, async (): Promise<BrowseInstallResult> => {
    if (!args.browse) return { view: { state: "missing" }, error: null };
    const { status, error } = await args.browse.install();
    return { view: { state: status.state }, error };
  });

  // Settings: may computer use run here, and has macOS allowed Bee Accessibility and Screen Recording. Fails open as unknown.
  ipcMain.handle(IPC.computerAccess, async (): Promise<ComputerAccessView> => {
    if (!args.computer) return { supported: false, platform: "other", accessibility: "unknown", screenRecording: "unknown" };
    const platform = args.computer.platform;
    // Screen Recording as macOS reports it for Bee itself, which look_at_screen needs; agent-desktop's own may differ.
    const screen = args.screenRecording ? { screenRecording: args.screenRecording() } : {};
    computerRuns += 1;
    try {
      const access = await computerAccess(args.computer.run);
      debugLog.info("computer", "access", { platform, ...access });
      return { supported: true, platform, ...access, ...screen };
    } catch (error) {
      debugLog.warn("computer", "access-failed", { platform, error: errorData(error) });
      return { supported: true, platform, accessibility: "unknown", screenRecording: "unknown", ...screen };
    } finally {
      computerRuns -= 1;
      releaseComputer();
    }
  });

  // Cancels Jev and Luna for a superseded run. A tool call that has started is left to finish (it may be a write).
  ipcMain.handle(IPC.cancelPipeline, (_event, payload) => {
    const { runId } = pipelineCancelSchema.parse(payload);
    debugLog.info("ai", "cancel", { runId, running: runs.has(String(runId)) });
    runs.get(String(runId))?.abort();
  });

  // Without a key (or if Luna fails) a plain summary is still written, so the meeting is never lost.
  ipcMain.handle(IPC.writeMeetingSummary, async (_event, payload): Promise<MeetingSummaryResult> => {
    const { sessionToken, ...input } = meetingSummaryRequestSchema.parse(payload);
    assertSignedIn(sessionToken);
    const when = new Date();
    const apiKey = args.gatewayApiKey();
    const started = performance.now();
    debugLog.info("meeting", "summary-start", { lines: input.transcript.length, notesCited: input.notesCited.length, tips: input.tips.length, meetingId: input.meetingId, hasKey: Boolean(apiKey) });
    const summary = apiKey
      ? await generateMeetingSummary({ ...input, model: createGateway(apiKey).languageModel(GUIDE_MODEL), when })
      : { markdown: buildLocalSummary({ ...input, when }), usedLlm: false, error: NO_GATEWAY_KEY };
    const path = writeMeetingSummaryFile(args.notesDir, summary.markdown, when);
    debugLog.info("meeting", "summary-written", { path, usedLlm: summary.usedLlm, error: summary.error, ms: msSince(started), markdown: summary.markdown });
    // Structured fields go to meeting memory too (when it is on and the meeting has a name). Failing to save never loses the note.
    try {
      const remembered = args.meeting.remember({ meetingId: input.meetingId, summaryMarkdown: summary.markdown, usedLlm: summary.usedLlm, tips: input.tips });
      console.debug(`perf meeting-memory saved=${remembered ? 1 : 0}`);
    } catch {
      console.debug("perf meeting-memory saved=0");
    }
    // Finished session 1 of 2: the meeting, once its summary file is safely written. Queued in the background, so the reply
    // never waits on vmem; a failure here is logged and never touches the summary.
    try {
      args.transcripts?.submit(meetingTranscript({ transcript: input.transcript, tips: input.tips, notesCited: input.notesCited, subject: args.meeting.subject?.(input.meetingId), when }));
    } catch (error) {
      debugLog.error("vmem", "transcript-render-failed", { kind: "meeting", error: errorData(error) });
    }
    const follow = followThrough({
      markdown: summary.markdown,
      usedLlm: summary.usedLlm,
      subject: args.meeting.subject?.(input.meetingId) ?? null,
      attendees: args.meeting.attendees?.(input.meetingId) ?? [],
    });
    if (follow) {
      followThroughs.set(path, follow);
      for (const old of [...followThroughs.keys()].slice(0, Math.max(0, followThroughs.size - FOLLOW_THROUGHS_KEPT))) followThroughs.delete(old);
    }
    return { path, usedLlm: summary.usedLlm, error: summary.error, followUp: follow ? followThroughLines(follow) : [] };
  });

  // Finished session 2 of 2: a conversation of direct requests, when the renderer sees no exchange with Bee for
  // CONVERSATION_IDLE_MS (store.ts endConversation("idle")). Bee's own history (bee-history.json) is never cleared by this. A
  // conversation that ends with a meeting is not sent; the meeting above covers it.
  ipcMain.handle(IPC.conversationEnded, (_event, payload) => {
    const { sessionToken, exchanges } = conversationEndedSchema.parse(payload);
    assertSignedIn(sessionToken);
    try {
      args.transcripts?.submit(conversationTranscript({ exchanges, when: new Date() }));
    } catch (error) {
      debugLog.error("vmem", "transcript-render-failed", { kind: "conversation", error: errorData(error) });
    }
  });

  ipcMain.handle(IPC.openMeetingSummary, (_event, payload) => {
    const path = z.string().max(4000).parse(payload);
    if (!isNotePath(args.notesDir, path)) throw new Error("Not a note in the notes folder");
    return shell.openPath(path);
  });
}
