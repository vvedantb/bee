// Record and replay of the Gateway models for the Electron E2E (BEE_E2E_MODE=record|replay; unset is live). The harness passes
// e2eGateway() to registerMeetingIpc, so the pipeline, Luna, steering and the UI run unchanged on top of these models.
// record: the real Gateway models run, and each doStream (Luna) and doEvaluate (Jev) call is written to
// <BEE_E2E_FIXTURES_DIR>/<model>.json as it ends: the stream parts with their time from the call's start, or Jev's answers.
// Any part is recorded as plain JSON, so a part type this file does not know never fails the live call; it only warns.
// Headers, request bodies, response ids, Gateway metadata, raw usage and encrypted search content are left out, and a
// file that still matches SECRET_PATTERNS is never written. The folder holds INCOMPLETE until the test calls
// completeRecording() after every check passed, and replay refuses a folder that holds it, so a failed recording never replays.
// replay: no network and no key. Calls are matched by order per model, never by prompt, so prompt edits do not break the
// fixtures; a prompt hash is kept only to warn on drift. Parts come out at their recorded times and stop on abort, so a
// steer still cancels the answer mid-stream. A recorded call that was cancelled waits for the replayed run to cancel too.
// Each part replays as recorded, but one that partSchema does not know replays as a "raw" chunk holding it (streamText drops
// raw chunks, and throws on a type outside the model spec), with a warning.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GatewayProvider } from "@ai-sdk/gateway";
import { wrapLanguageModel } from "ai";
import { z } from "zod";
import { createBeeGateway, type BeeGateway } from "../../src/core/gateway";

type LanguageModel = ReturnType<GatewayProvider["languageModel"]>;
type StreamResult = Awaited<ReturnType<LanguageModel["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer T> ? T : never;
type EvaluationModel = ReturnType<GatewayProvider["evaluationModel"]>;

export const e2eModeSchema = z.enum(["record", "replay"]);
export type E2eMode = z.infer<typeof e2eModeSchema>;

/** Key-like text that must never be in a fixture. Word-bounded so news text such as "risk-free" does not match. */
export const SECRET_PATTERNS = [/\bvck_/i, /\bsk-[\w-]{6,}/i, /\bBearer\s+\S/i, /api[_-]?key/i];
export const hasSecret = (text: string) => SECRET_PATTERNS.some((pattern) => pattern.test(text));

export const NO_FIXTURES = "No replay fixtures: run the test once in record mode (see the top of test/conversation-live.e2e.test.ts).";
// Written when a recording starts and removed by completeRecording(). Not .json, so it is never read as a fixture.
export const INCOMPLETE = "INCOMPLETE";
// The key the harness hands meeting-ipc in replay, so a run goes through the (replayed) Gateway path.
export const REPLAY_KEY = "replay-no-key";
// A recorded call that was cancelled waits this long for the replayed run to cancel too.
const CANCEL_WAIT_MS = 30_000;
// Dropped from every recorded part: never needed to replay, and may carry ids, routing or bulky encrypted pages.
const DROPPED_KEYS = new Set(["headers", "request", "rawValue", "gateway", "encryptedContent", "encrypted_content"]);

const json = z.json();
const metadata = z.record(z.string(), z.record(z.string(), json)).optional();
const withId = { id: z.string(), providerMetadata: metadata };
const delta = { ...withId, delta: z.string() };
const count = z.number().optional();
const usage = z
  .object({
    inputTokens: z.object({ total: count, noCache: count, cacheRead: count, cacheWrite: count }),
    outputTokens: z.object({ total: count, text: count, reasoning: count }),
  })
  // The model spec wants every key present, undefined or not; JSON drops the undefined ones.
  .transform(({ inputTokens: input, outputTokens: output }) => ({
    inputTokens: { total: input.total, noCache: input.noCache, cacheRead: input.cacheRead, cacheWrite: input.cacheWrite },
    outputTokens: { total: output.total, text: output.text, reasoning: output.reasoning },
  }));
const finishReason = z
  .object({ unified: z.enum(["stop", "length", "content-filter", "tool-calls", "error", "other"]), raw: z.string().optional() })
  .transform(({ unified, raw }) => ({ unified, raw }));
const toolResult = z.union([z.string(), z.number(), z.boolean(), z.array(json), z.record(z.string(), json)]);

// The stream parts replay knows, as stored (input) and as replayed (output).
const knownPartSchema = z.union([
  z.object({ type: z.literal("stream-start"), warnings: z.tuple([]) }),
  z.object({ type: z.literal("response-metadata"), modelId: z.string().optional(), timestamp: z.iso.datetime().transform((at) => new Date(at)).optional() }),
  z.object({ type: z.enum(["text-start", "text-end", "reasoning-start", "reasoning-end", "tool-input-end"]), ...withId }),
  z.object({ type: z.enum(["text-delta", "reasoning-delta", "tool-input-delta"]), ...delta }),
  z.object({ type: z.literal("tool-input-start"), ...withId, toolName: z.string(), providerExecuted: z.boolean().optional(), dynamic: z.boolean().optional(), title: z.string().optional() }),
  z.object({ type: z.literal("tool-call"), toolCallId: z.string(), toolName: z.string(), input: z.string(), providerExecuted: z.boolean().optional(), dynamic: z.boolean().optional(), providerMetadata: metadata }),
  z.object({ type: z.literal("tool-result"), toolCallId: z.string(), toolName: z.string(), result: toolResult, isError: z.boolean().optional(), preliminary: z.boolean().optional(), dynamic: z.boolean().optional(), providerMetadata: metadata }),
  z.object({ type: z.literal("source"), sourceType: z.literal("url"), id: z.string(), url: z.string(), title: z.string().optional(), providerMetadata: metadata }),
  z.object({ type: z.literal("source"), sourceType: z.literal("document"), id: z.string(), mediaType: z.string(), title: z.string(), filename: z.string().optional(), providerMetadata: metadata }),
  z.object({ type: z.literal("custom"), kind: z.templateLiteral([z.string(), ".", z.string()]), providerMetadata: metadata }),
  z.object({ type: z.literal("tool-approval-request"), approvalId: z.string(), toolCallId: z.string(), providerMetadata: metadata }),
  z.object({ type: z.literal("finish"), usage, finishReason, providerMetadata: metadata }),
  z.object({ type: z.literal("error"), error: z.string().transform((message) => new Error(message)) }),
]);
const warned = new Set<string>();
/** Warns once per part type that replay does not know. */
const warnUnknown = (type: string, what: string) => {
  if (warned.has(type)) return;
  warned.add(type);
  console.warn(`Bee replay: a "${type}" stream part ${what}; it replays as a raw chunk.`);
};
const rawPart = (rawValue: Json): StreamPart => ({ type: "raw", rawValue });
// Any stored part: a known one as itself, anything else as a raw chunk holding it.
const partSchema = z.union([
  knownPartSchema,
  z.looseObject({ type: z.string() }).transform((part) => {
    warnUnknown(part.type, "is not one replay knows");
    return rawPart(json.parse(part));
  }),
]);

const probabilities = z.record(z.string(), z.number()).optional();
const answerSchema = z.union([
  z.object({ type: z.literal("choice"), choice: z.string(), probabilities }),
  z.object({ type: z.literal("score"), score: z.number(), probabilities }),
  z.object({ type: z.literal("boolean"), probability: z.number() }),
]);

// How a recorded call ended. "cancelled": the run was aborted (a steer or a newer line); "error": the call failed.
const ending = { end: z.enum(["finish", "cancelled", "error"]), error: z.string().optional() };
const callSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stream"), index: z.number(), promptHash: z.string(), ...ending, parts: z.array(z.object({ at: z.number(), part: partSchema })) }),
  z.object({ kind: z.literal("evaluate"), index: z.number(), promptHash: z.string(), ...ending, ms: z.number(), answers: z.record(z.string(), answerSchema) }),
]);
type ReplayCall = z.output<typeof callSchema>;
export const fixtureSchema = z.object({ model: z.string(), calls: z.array(callSchema) });

type Json = z.infer<typeof json>;
type Ending = { end: ReplayCall["end"]; error?: string; promptHash: string };
// A call as written: parts are plain JSON.
type RecordedCall = Ending &
  ({ kind: "stream"; parts: Array<{ at: number; part: Json }> } | { kind: "evaluate"; ms: number; answers: Awaited<ReturnType<EvaluationModel["doEvaluate"]>>["answers"] });

const fileName = (modelId: string) => `${modelId.replace(/[^a-z0-9.]+/gi, "-")}.json`;
const promptHash = (value: object) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The fixture files in a folder (none if it does not exist). */
export function fixtureFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")).sort() : [];
}

/** A JSON copy of the value without DROPPED_KEYS. */
function scrub(value: Json): Json {
  if (Array.isArray(value)) return value.map(scrub);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !DROPPED_KEYS.has(key)).map(([key, item]) => [key, scrub(item)]));
}

/** A stream part as stored. Raw chunks are skipped; warnings, the response id and raw usage are left out. Never throws on a new type. */
function storedPart(part: StreamPart): Json | null {
  if (part.type === "raw") return null;
  const plain =
    part.type === "stream-start" ? { type: part.type, warnings: [] }
    : part.type === "response-metadata" ? { type: part.type, modelId: part.modelId, timestamp: part.timestamp?.toISOString() }
    : part.type === "error" ? { type: part.type, error: message(part.error) }
    : part.type === "finish" ? { ...part, usage: { inputTokens: part.usage.inputTokens, outputTokens: part.usage.outputTokens } }
    : part;
  // Through JSON first: drops undefined keys and anything that is not data.
  const copy = scrub(json.parse(JSON.parse(JSON.stringify(plain))));
  if (!knownPartSchema.safeParse(copy).success) warnUnknown(part.type, "was recorded that replay does not know");
  return copy;
}

const recordError = (detail: { model: string; call: number; error: string }) => process.stdout.write(`E2E_RECORD_ERROR ${JSON.stringify(detail)}\n`);

/** Marks a recording as whole: call it only after the recording run passed every check. Until then replay refuses the folder. */
export function completeRecording(dir: string) {
  rmSync(join(dir, INCOMPLETE), { force: true });
}

/** Writes each call to <dir>/<model>.json as it ends. Old fixtures in the folder are removed first, and INCOMPLETE is written. */
function createRecorder(dir: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, INCOMPLETE), "A recording started here and has not passed. Re-run record mode.\n");
  for (const name of fixtureFiles(dir)) rmSync(join(dir, name));
  const models = new Map<string, { next: number; calls: Map<number, RecordedCall & { index: number }> }>();
  const model = (modelId: string) => {
    const entry = models.get(modelId) ?? { next: 0, calls: new Map<number, RecordedCall & { index: number }>() };
    models.set(modelId, entry);
    return entry;
  };
  return {
    /**
     * Reserves the next slot for this model at call time, so the order is the order the calls started in. The returned save
     * keeps the first ending only. A call with key-like text is not written and is reported as "E2E_RECORD_ERROR {...}";
     * so is a part that could not be stored (`fail`), and that call is then never written.
     */
    begin(modelId: string) {
      const entry = model(modelId);
      const index = entry.next++;
      let saved = false;
      const fail = (error: unknown) => {
        if (saved) return;
        saved = true;
        recordError({ model: modelId, call: index, error: message(error) });
      };
      const save = (call: RecordedCall) => {
        if (saved) return;
        saved = true;
        const candidate = new Map(entry.calls).set(index, { index, ...call });
        const text = `${JSON.stringify({ model: modelId, calls: [...candidate.values()].sort((a, b) => a.index - b.index) }, null, 2)}\n`;
        if (hasSecret(text)) return recordError({ model: modelId, call: index, error: "key-like text; not written" });
        entry.calls.set(index, { index, ...call });
        writeFileSync(join(dir, fileName(modelId)), text);
      };
      return { save, fail };
    },
  };
}
type Recorder = ReturnType<typeof createRecorder>;

function recordingLanguageModel(model: LanguageModel, recorder: Recorder): LanguageModel {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v4",
      wrapStream: async ({ doStream, params }) => {
        const started = performance.now();
        const { save, fail } = recorder.begin(model.modelId);
        const hash = promptHash(params.prompt);
        const parts: Array<{ at: number; part: Json }> = [];
        const end = (how: Ending["end"], error?: unknown) =>
          save({ kind: "stream", promptHash: hash, end: how, error: error === undefined ? undefined : message(error), parts });
        const failed = (error: unknown) => end(params.abortSignal?.aborted ? "cancelled" : "error", error);
        params.abortSignal?.addEventListener("abort", () => end("cancelled"), { once: true });
        const result = await Promise.resolve(doStream()).catch((error: unknown) => {
          failed(error);
          throw error;
        });
        const reader = result.stream.getReader();
        const stream = new ReadableStream<StreamPart>({
          async pull(controller) {
            const next = await reader.read().catch((error: unknown) => {
              failed(error);
              throw error;
            });
            if (next.done) {
              end("finish");
              controller.close();
              return;
            }
            // A part that cannot be stored fails the recording, never the live call.
            try {
              const part = storedPart(next.value);
              if (part) parts.push({ at: Math.round(performance.now() - started), part });
            } catch (error) {
              fail(new Error(`Cannot record a "${next.value.type}" stream part: ${message(error)}`));
            }
            controller.enqueue(next.value);
          },
          cancel(reason) {
            end("cancelled");
            return reader.cancel(reason);
          },
        });
        return { ...result, stream };
      },
    },
  });
}

function recordingEvaluationModel(model: EvaluationModel, recorder: Recorder): EvaluationModel {
  return {
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
    supportedQuestionTypes: model.supportedQuestionTypes,
    doEvaluate: async (options) => {
      const started = performance.now();
      const { save } = recorder.begin(model.modelId);
      const hash = promptHash({ state: options.state, questions: options.questions });
      const ms = () => Math.round(performance.now() - started);
      try {
        const result = await model.doEvaluate(options);
        save({ kind: "evaluate", promptHash: hash, end: "finish", ms: ms(), answers: result.answers });
        return result;
      } catch (error) {
        save({ kind: "evaluate", promptHash: hash, end: options.abortSignal?.aborted ? "cancelled" : "error", error: message(error), ms: ms(), answers: {} });
        throw error;
      }
    },
  };
}

/** Resolves at `at` (performance.now() time), or rejects with the signal's reason when it aborts first. */
function waitUntil(at: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, at - performance.now()));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Loads every fixture in the folder. Throws NO_FIXTURES when there are none, and refuses an incomplete recording. */
function createPlayer(dir: string) {
  const files = fixtureFiles(dir);
  if (files.length === 0) throw new Error(`${NO_FIXTURES} Looked in ${dir}.`);
  if (existsSync(join(dir, INCOMPLETE))) throw new Error(`Replay fixtures in ${dir} are from a recording that failed or did not finish. Re-run record mode.`);
  const fixtures = new Map(files.map((name) => {
    const fixture = fixtureSchema.parse(JSON.parse(readFileSync(join(dir, name), "utf8")));
    return [fixture.model, { calls: fixture.calls, next: 0 }];
  }));
  /** The next recorded call for this model. A call with no fixture fails loudly: the scenario changed, so re-record. */
  const take = (modelId: string, hash: string): ReplayCall => {
    const fixture = fixtures.get(modelId);
    const index = fixture ? fixture.next++ : 0;
    const call = fixture?.calls.find((item) => item.index === index);
    const recorded = `${fixture?.calls.length ?? 0} recorded`;
    if (!call) throw new Error(`No replay fixture for call ${index} to ${modelId} (${recorded}, prompt ${hash}) in ${dir}. Re-run record mode.`);
    if (call.promptHash !== hash) console.warn(`Bee replay: call ${index} to ${modelId} has a new prompt (${call.promptHash} → ${hash}); replaying by order.`);
    return call;
  };
  const wrongKind = (call: ReplayCall, modelId: string) => new Error(`Replay call ${call.index} to ${modelId} was recorded as ${call.kind}. Re-run record mode.`);
  return {
    stream(modelId: string, hash: string) {
      const call = take(modelId, hash);
      if (call.kind !== "stream") throw wrongKind(call, modelId);
      return call;
    },
    evaluate(modelId: string, hash: string) {
      const call = take(modelId, hash);
      if (call.kind !== "evaluate") throw wrongKind(call, modelId);
      return call;
    },
  };
}
type Player = ReturnType<typeof createPlayer>;

function replayLanguageModel(modelId: string, player: Player): LanguageModel {
  const fail = (what: string) => () => Promise.reject(new Error(`Bee replay: ${what} to ${modelId} is not recorded.`));
  return {
    specificationVersion: "v4",
    provider: "replay",
    modelId,
    supportedUrls: {},
    doGenerate: fail("generateText"),
    doStream: async (options) => {
      const call = player.stream(modelId, promptHash(options.prompt));
      const signal = options.abortSignal;
      const started = performance.now();
      let next = 0;
      const stream = new ReadableStream<StreamPart>({
        async pull(controller) {
          const item = call.parts[next++];
          if (item) {
            await waitUntil(started + item.at, signal);
            const part: StreamPart = item.part;
            controller.enqueue(part);
            return;
          }
          if (call.end === "cancelled") {
            await waitUntil(started + Math.max(CANCEL_WAIT_MS, (call.parts.at(-1)?.at ?? 0) + CANCEL_WAIT_MS), signal);
            throw new Error(`Bee replay: call ${call.index} to ${modelId} was cancelled when recorded, but not in replay. Re-run record mode.`);
          }
          if (call.end === "error") throw new Error(call.error ?? "Recorded call failed");
          controller.close();
        },
      });
      return { stream };
    },
  };
}

function replayEvaluationModel(modelId: string, player: Player): EvaluationModel {
  return {
    specificationVersion: "v4",
    provider: "replay",
    modelId,
    supportedQuestionTypes: ["score", "choice", "boolean"],
    doEvaluate: async (options) => {
      const call = player.evaluate(modelId, promptHash({ state: options.state, questions: options.questions }));
      await waitUntil(performance.now() + call.ms, options.abortSignal);
      if (call.end !== "finish") throw new Error(call.error ?? "Recorded call failed");
      return { answers: call.answers, warnings: [] };
    },
  };
}

/**
 * The gateway factory registerMeetingIpc uses in this mode. Replay loads the fixtures now, so a missing set fails at start.
 * `real` is the Gateway that record wraps (a mock in the unit test).
 */
export function e2eGateway(mode: E2eMode, dir: string, real: (apiKey: string) => BeeGateway = createBeeGateway): (apiKey: string) => BeeGateway {
  const sttMissing = () => {
    throw new Error("Bee replay: speech-to-text is not recorded; the conversation test injects lines instead.");
  };
  if (mode === "replay") {
    const player = createPlayer(dir);
    const gateway: BeeGateway = {
      languageModel: (modelId) => replayLanguageModel(modelId, player),
      evaluationModel: (modelId) => replayEvaluationModel(modelId, player),
      transcription: sttMissing,
    };
    return () => gateway;
  }
  const recorder = createRecorder(dir);
  return (apiKey) => {
    const gateway = real(apiKey);
    return {
      languageModel: (modelId) => recordingLanguageModel(gateway.languageModel(modelId), recorder),
      evaluationModel: (modelId) => recordingEvaluationModel(gateway.evaluationModel(modelId), recorder),
      transcription: (modelId) => gateway.transcription(modelId),
    };
  };
}
