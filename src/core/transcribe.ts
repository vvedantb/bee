import { NoTranscriptGeneratedError, experimental_transcribe, type TranscriptionModel } from "ai";
import { FLEX_PROVIDER_OPTIONS } from "./gateway";

const STT_TIMEOUT_MS = 20_000;

export type TranscribeOutcome = { text: string | null; error: string | null };

/** One spoken phrase (WAV bytes) → text. Silence or noise with no words comes back as text null, error null. */
export async function transcribeSpeech(args: {
  model: TranscriptionModel;
  audio: Uint8Array;
  timeoutMs?: number;
}): Promise<TranscribeOutcome> {
  try {
    const result = await experimental_transcribe({
      model: args.model,
      audio: args.audio,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(args.timeoutMs ?? STT_TIMEOUT_MS),
      providerOptions: FLEX_PROVIDER_OPTIONS,
    });
    const text = result.text.replace(/\s+/g, " ").trim();
    // Punctuation-only output ("." or "…") is what STT returns for a cough or a click.
    return { text: /\p{L}|\p{N}/u.test(text) ? text : null, error: null };
  } catch (error) {
    if (NoTranscriptGeneratedError.isInstance(error)) return { text: null, error: null };
    return { text: null, error: `Speech-to-text failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
