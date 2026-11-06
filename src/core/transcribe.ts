import { NoTranscriptGeneratedError, experimental_transcribe, type TranscriptionModel } from "ai";
import { debugLog, errorData, modelName, msSince } from "./debug-log";
import { isKnownApp } from "./desktop-actions";
import { gatewayTier } from "./gateway";
import { remapHeardNames, sttTerms } from "./known-names";

const STT_TIMEOUT_MS = 20_000;

export type TranscribeOutcome = { text: string | null; error: string | null };

/**
 * Provider options for one phrase: the Gateway's default tier, and the known names as terms to bias recognition toward.
 *
 * Names go as `xai.keyterm` (a list of terms). The installed SDK types give grok-stt no such option (neither @ai-sdk/gateway nor
 * `ai` names one), so it is sent untyped. It is the option the published @ai-sdk/xai package (5.0.39, not a dependency here)
 * declares for xAI transcription ("Terms to bias transcription toward"), and the Gateway passes providerOptions through to the
 * provider. Not checked against the live Gateway: no key here. If the Gateway rejects the request with the terms, Bee asks once
 * more without them (transcribeSpeech), so a hint can never cost the phrase. Whether or not the hint is applied, the transcript is
 * then checked against the same names (remapHeardNames).
 */
export function sttProviderOptions(knownNames: readonly string[] = []) {
  const terms = sttTerms(knownNames);
  return terms.length > 0 ? { ...gatewayTier("default"), xai: { keyterm: terms } } : gatewayTier("default");
}

/** A request the provider refused as malformed (an option it does not take), not a network or auth failure. */
const refused = (error: unknown): boolean => {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return status === 400 || status === 422;
};

/** One spoken phrase (WAV bytes) → text. Silence or noise with no words comes back as text null, error null. */
export async function transcribeSpeech(args: {
  model: TranscriptionModel;
  audio: Uint8Array;
  timeoutMs?: number;
  /** Which capture the phrase came from, for the local debug log only. */
  source?: "mic" | "teams-audio";
  /** Names the user taught Bee (Settings): sent as recognition hints. */
  knownNames?: readonly string[];
  /**
   * Put a misheard name in its one known spelling before the text is used (core/known-names.ts remapHeardNames). For the user's
   * own mic, where the wake word and the request are read next; never other people's speech.
   */
  remapNames?: boolean;
}): Promise<TranscribeOutcome> {
  const started = performance.now();
  const known = args.knownNames ?? [];
  const about = { source: args.source ?? null, model: modelName(args.model), bytes: args.audio.byteLength, hints: sttTerms(known).length };
  debugLog.debug("stt", "request", about);
  const transcribe = (providerOptions: ReturnType<typeof sttProviderOptions>) =>
    experimental_transcribe({
      model: args.model,
      audio: args.audio,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(args.timeoutMs ?? STT_TIMEOUT_MS),
      // User-facing: not flex (see gateway.ts).
      providerOptions,
    });
  try {
    let result: Awaited<ReturnType<typeof transcribe>>;
    try {
      result = await transcribe(sttProviderOptions(known));
    } catch (error) {
      if (about.hints === 0 || !refused(error)) throw error;
      debugLog.warn("stt", "hints-refused", { ...about, ms: msSince(started), error: errorData(error) });
      result = await transcribe(gatewayTier("default"));
    }
    console.debug(`perf stt ${Math.round(performance.now() - started)}ms`);
    const heard = result.text.replace(/\s+/g, " ").trim();
    // Punctuation-only output ("." or "…") is what STT returns for a cough or a click.
    const words = /\p{L}|\p{N}/u.test(heard);
    const remapped = words && args.remapNames ? remapHeardNames(heard, known, { skip: isKnownApp }) : { text: heard, changes: [] };
    const text = remapped.text;
    debugLog.info("stt", "result", {
      ...about,
      ms: msSince(started),
      text,
      ...(remapped.changes.length > 0 ? { heard, names: remapped.changes } : {}),
      words,
      language: result.language ?? null,
      seconds: result.durationInSeconds ?? null,
    });
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
