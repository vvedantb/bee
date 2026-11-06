import { NoTranscriptGeneratedError, experimental_transcribe, type TranscriptionModel } from "ai";
import { debugLog, errorData, modelName, msSince } from "./debug-log";
import { gatewayTier } from "./gateway";

const STT_TIMEOUT_MS = 20_000;

/** Bee's own words, which every model mishears ("Bee" comes back as "B"). The user's names come from Settings → Known names. */
export const STT_TERMS = ["Bee", "Jev", "vmem"] as const;
// Words sent to the model at most. The Gateway took 200 without an error, but Mistral documents no limit, so stay small.
const VOCABULARY_MAX = 100;

/** The words the model should listen for: Bee's terms, then the user's known names, newest first, with no repeats (any case). */
export function sttVocabulary(knownNames: readonly string[]): string[] {
  const seen = new Set<string>();
  return [...STT_TERMS, ...[...knownNames].reverse()].filter((word) => !seen.has(word.toLowerCase()) && seen.add(word.toLowerCase())).slice(0, VOCABULARY_MAX);
}

export type TranscribeOutcome = { text: string | null; error: string | null };

/** One spoken phrase (WAV bytes) → text. Silence or noise with no words comes back as text null, error null. */
export async function transcribeSpeech(args: {
  model: TranscriptionModel;
  audio: Uint8Array;
  timeoutMs?: number;
  /** Words to listen for (sttVocabulary). Sent as Mistral's contextBias: other providers ignore their own options. */
  vocabulary?: readonly string[];
  /** Which capture the phrase came from, for the local debug log only. */
  source?: "mic" | "teams-audio";
}): Promise<TranscribeOutcome> {
  const started = performance.now();
  const about = { source: args.source ?? null, model: modelName(args.model), bytes: args.audio.byteLength };
  debugLog.debug("stt", "request", about);
  try {
    const result = await experimental_transcribe({
      model: args.model,
      audio: args.audio,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(args.timeoutMs ?? STT_TIMEOUT_MS),
      // User-facing: not flex (see gateway.ts). The Gateway passes the mistral options to Voxtral.
      providerOptions: { ...gatewayTier("default"), ...(args.vocabulary?.length ? { mistral: { contextBias: [...args.vocabulary] } } : {}) },
    });
    console.debug(`perf stt ${Math.round(performance.now() - started)}ms`);
    const text = result.text.replace(/\s+/g, " ").trim();
    // Punctuation-only output ("." or "…") is what STT returns for a cough or a click.
    const words = /\p{L}|\p{N}/u.test(text);
    debugLog.info("stt", "result", { ...about, ms: msSince(started), text, words, language: result.language ?? null, seconds: result.durationInSeconds ?? null });
    return { text: words ? text : null, error: null };
  } catch (error) {
    if (NoTranscriptGeneratedError.isInstance(error)) {
      debugLog.info("stt", "result", { ...about, ms: msSince(started), text: null, words: false });
      return { text: null, error: null };
    }
    debugLog.warn("stt", "failed", { ...about, ms: msSince(started), error: errorData(error) });
    return { text: null, error: `Speech-to-text failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
