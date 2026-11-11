import { experimental_evaluate, type Experimental_EvaluationModel, type Experimental_EvaluationQuestion } from "ai";
import { withTimeout } from "./abort";
import { debugLog, errorData, modelName, msSince } from "./debug-log";

// Which path a direct request takes, asked of Jev (the Gateway evaluation API, as in jev.ts and link-jev.ts) in one choice
// question. Only asked when the word rules leave it open (core/direct-command.ts: no quick open, and computer use is there), and
// only for ROUTE_TIMEOUT_MS: Jev answers in about 100 to 200 ms in the US, but from the UK it took over 300 ms every time
// (all timed out at 300), so the budget allows the round trip; a request must not wait longer. Any timeout, error, unknown
// option or weak answer returns null, and the word rules (core/desktop-actions.ts routeCommand, core/computer-use.ts
// wantsComputerUse) decide as before. Standard tier, not flex: it sits on the path to the user's answer.
//
// state: { request } — the request after the wake word.
// questions: "route", a choice over ROUTE_OPTIONS.

export const ROUTE_TIMEOUT_MS = 800;
// Below this probability for the chosen option (when Jev gives one), the word rules decide.
export const ROUTE_MIN_PROBABILITY = 0.55;

export const ROUTE_OPTIONS = {
  computer_use: "Bee must operate apps on screen, step by step: click, type, send a message, close a tab, fill a form, change something in an app.",
  direct_answer: "A question or request for an explanation, a calculation or facts: Bee answers in words and does nothing on screen.",
  open_app: "Only open one app, with nothing else to do in it.",
  focus_app: "Only switch to or bring forward one app that is already open.",
  open_url: "Only open one web page or web address.",
  ai: "Anything else: notes, connected tools, web search, or a request that is unclear.",
} as const;
export type JevRoute = keyof typeof ROUTE_OPTIONS;

const isRoute = (value: unknown): value is JevRoute => typeof value === "string" && Object.hasOwn(ROUTE_OPTIONS, value);

export function buildRouteRequest(command: string): { state: { request: string }; questions: Record<string, Experimental_EvaluationQuestion> } {
  return {
    state: { request: command.replace(/\s+/g, " ").trim() },
    questions: {
      route: {
        type: "choice",
        instructions: { task: "The user spoke this request to Bee, a desktop assistant. Choose how Bee should handle it." },
        criteria: ROUTE_OPTIONS,
      },
    },
  };
}

/** The chosen route, or null when the answer is missing, unknown or too unsure. */
export function parseRouteAnswer(answer: unknown, minProbability = ROUTE_MIN_PROBABILITY): JevRoute | null {
  if (typeof answer !== "object" || answer === null) return null;
  const { type, choice, probabilities } = answer as { type?: unknown; choice?: unknown; probabilities?: unknown };
  if (type !== "choice" || !isRoute(choice)) return null;
  if (typeof probabilities === "object" && probabilities !== null) {
    const p = (probabilities as Record<string, unknown>)[choice];
    if (typeof p === "number" && Number.isFinite(p) && p < minProbability) return null;
  }
  return choice;
}

/** Rejects when the signal aborts; never settles otherwise. */
function whenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const fail = () => reject(signal.reason instanceof Error ? signal.reason : new Error("Jev routing timed out"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

/** Jev's route for a request, or null (time out, error, unusable answer): the caller falls back to the word rules. Never throws. */
export async function routeWithJev(args: { model: Experimental_EvaluationModel; command: string; signal?: AbortSignal; timeoutMs?: number }): Promise<JevRoute | null> {
  const started = performance.now();
  try {
    const request = buildRouteRequest(args.command);
    const signal = withTimeout(args.signal, args.timeoutMs ?? ROUTE_TIMEOUT_MS);
    // Raced against the signal too, so the budget holds even when a transport does not stop at once.
    const result = await Promise.race([
      experimental_evaluate({ model: args.model, state: request.state, questions: request.questions, maxRetries: 0, abortSignal: signal }),
      whenAborted(signal),
    ]);
    const answer = (result.answers as Record<string, unknown>).route;
    const route = parseRouteAnswer(answer);
    debugLog.info("ai", "jev-route", { model: modelName(args.model), ms: msSince(started), answer, route });
    return route;
  } catch (error) {
    debugLog.info("ai", "jev-route-failed", { ms: msSince(started), aborted: args.signal?.aborted ?? false, error: errorData(error) });
    return null;
  }
}
