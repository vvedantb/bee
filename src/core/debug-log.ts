// Bee's local debug log: structured events from core, main and the renderer, for reading a session back. Pure: nothing is
// written here. Main installs the sink that writes JSON Lines under the user data folder (main/debug-log.ts); the renderer
// installs one that batches events to main (renderer/src/debug-log.ts). Without a sink (tests, scripts) every call is a
// no-op. The log stays on this computer: it is never uploaded.

export const DEBUG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type DebugLevel = (typeof DEBUG_LEVELS)[number];
export type DebugData = Record<string, unknown>;
export type DebugEvent = { level: DebugLevel; category: string; event: string; data?: DebugData };

export type DebugSink = {
  write: (event: DebugEvent) => void;
  /** Whether events at this level are kept now (Settings → Verbose logging). Lets a caller skip building costly data. */
  wants: (level: DebugLevel) => boolean;
};

let sink: DebugSink | null = null;

/** Installs (or with null, removes) the process's sink. */
export function setDebugSink(next: DebugSink | null): void {
  sink = next;
}

function emit(level: DebugLevel, category: string, event: string, data?: DebugData): void {
  if (!sink) return;
  // Logging must never break the code it watches.
  try {
    if (sink.wants(level)) sink.write(data === undefined ? { level, category, event } : { level, category, event, data });
  } catch {
    // Dropped.
  }
}

export const debugLog = {
  debug: (category: string, event: string, data?: DebugData) => emit("debug", category, event, data),
  info: (category: string, event: string, data?: DebugData) => emit("info", category, event, data),
  warn: (category: string, event: string, data?: DebugData) => emit("warn", category, event, data),
  error: (category: string, event: string, data?: DebugData) => emit("error", category, event, data),
  /** True when a sink is installed and keeps this level. */
  wants: (level: DebugLevel): boolean => {
    try {
      return sink?.wants(level) ?? false;
    } catch {
      return false;
    }
  },
};

/** An error as plain data for the log: name, message, stack and cause. Anything else as its text. */
export function errorData(error: unknown): { name?: string; message: string; stack?: string; cause?: string } {
  if (error instanceof Error) {
    const cause = error.cause === undefined ? undefined : error.cause instanceof Error ? error.cause.message : String(error.cause);
    return { name: error.name, message: error.message, ...(error.stack ? { stack: error.stack } : {}), ...(cause ? { cause } : {}) };
  }
  return { message: typeof error === "string" ? error : safeString(error) };
}

function safeString(value: unknown): string {
  try {
    return typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/** Milliseconds since a performance.now() start, to 0.1 ms. */
export const msSince = (started: number): number => Math.round((performance.now() - started) * 10) / 10;

/** The model's id for the log ("anthropic/claude-…"), whether it was given as a string or a model object. */
export function modelName(model: unknown): string | null {
  if (typeof model === "string") return model;
  if (typeof model === "object" && model !== null && "modelId" in model && typeof model.modelId === "string") return model.modelId;
  return null;
}

// 32-bit FNV-1a: enough to tell prompts apart in one session. Not for security.
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const seenPrompts = new Set<string>();

/**
 * A long, mostly fixed text (a system prompt) for the log: its hash every time, and the full text only the first time this
 * process sees it, so the same few kilobytes are not written with every request.
 */
export function onceText(text: string): { hash: string; chars: number; text?: string } {
  const hash = fnv1a(text);
  if (seenPrompts.has(hash)) return { hash, chars: text.length };
  seenPrompts.add(hash);
  return { hash, chars: text.length, text };
}

type StepLike = {
  stepNumber?: number;
  finishReason?: unknown;
  text?: string;
  usage?: unknown;
  toolCalls?: ReadonlyArray<{ toolName: string; toolCallId?: string; input?: unknown }>;
  toolResults?: ReadonlyArray<{ toolName: string; toolCallId?: string; output?: unknown }>;
};

/** One model step for the log: its text, tool calls with their input, tool results, finish reason and usage. */
export function stepData(step: StepLike): DebugData {
  return {
    step: step.stepNumber,
    finishReason: step.finishReason,
    text: step.text,
    toolCalls: step.toolCalls?.map((call) => ({ id: call.toolCallId, tool: call.toolName, input: call.input })),
    toolResults: step.toolResults?.map((result) => ({ id: result.toolCallId, tool: result.toolName, output: result.output })),
    usage: step.usage,
  };
}

type ConsoleMethod = "debug" | "info" | "log" | "warn" | "error";
const CONSOLE_LEVEL: Record<ConsoleMethod, DebugLevel> = { debug: "debug", info: "info", log: "info", warn: "warn", error: "error" };
let teeing = false;

/** Console arguments as one line of text, with any errors kept whole beside it. */
export function consoleData(args: readonly unknown[]): DebugData {
  const errors = args.filter((arg): arg is Error => arg instanceof Error).map(errorData);
  const message = args.map((arg) => (typeof arg === "string" ? arg : arg instanceof Error ? `${arg.name}: ${arg.message}` : safeString(arg))).join(" ");
  return errors.length > 0 ? { message, errors } : { message };
}

/**
 * Copies console output into the log (category "console"), so Bee's existing "perf …" and code lines are in it too. The
 * console itself prints as before. Returns a function that puts the original methods back.
 */
export function teeConsole(target: Pick<Console, ConsoleMethod>): () => void {
  const original = { debug: target.debug, info: target.info, log: target.log, warn: target.warn, error: target.error };
  for (const method of Object.keys(original) as ConsoleMethod[]) {
    const print = original[method];
    target[method] = (...args: unknown[]) => {
      print.apply(target, args);
      // Anything the sink itself prints must not come back round.
      if (teeing) return;
      teeing = true;
      try {
        if (debugLog.wants(CONSOLE_LEVEL[method])) emit(CONSOLE_LEVEL[method], "console", method, consoleData(args));
      } finally {
        teeing = false;
      }
    };
  }
  return () => Object.assign(target, original);
}
