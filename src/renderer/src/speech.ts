// Web Speech API wrapper: continuous English recognition with interim text and coalesced final utterances.
// Kept free of window/React so it can be tested with a mock recognition class.

export type RecognitionResult = {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: { readonly transcript: string };
};

export type RecognitionEvent = { readonly resultIndex: number; readonly results: ArrayLike<RecognitionResult> };

export type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { readonly error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
};

export type RecognitionConstructor = new () => Recognition;

/** Finals arriving within this window are joined into one transcript line, so one sentence runs the pipeline once. */
export const FINAL_COALESCE_MS = 700;

const ERROR_MESSAGES: Record<string, string> = {
  "not-allowed": "Microphone access was blocked. Allow it and try again.",
  "service-not-allowed": "Speech-to-text is blocked in this build. Use Simulate meeting line.",
  network: "Speech-to-text service unreachable (network error). Use Simulate meeting line.",
  "audio-capture": "No microphone found.",
  "language-not-supported": "English speech-to-text is not available.",
};

export function speechErrorMessage(code: string): string {
  return ERROR_MESSAGES[code] ?? `Speech-to-text failed: ${code}`;
}

/** Starts recognition. Returns stop(), which forwards any pending final text before ending. */
export function startSpeech(args: {
  Recognition: RecognitionConstructor;
  onInterim: (text: string) => void;
  onFinal: (line: string) => void;
  onError: (message: string) => void;
  coalesceMs?: number;
}): () => void {
  const recognition = new args.Recognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = "en-US";

  let pending: string[] = [];
  let interim = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function flush(): void {
    clearTimeout(timer);
    timer = undefined;
    const line = pending.join(" ").trim();
    pending = [];
    args.onInterim(interim);
    if (line) args.onFinal(line);
  }

  function fail(message: string): void {
    stopped = true;
    clearTimeout(timer);
    args.onError(message);
  }

  recognition.onresult = (event) => {
    let latestInterim = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const text = result?.[0]?.transcript.trim() ?? "";
      if (!result || !text) continue;
      if (result.isFinal) pending.push(text);
      else latestInterim = `${latestInterim} ${text}`.trim();
    }
    interim = latestInterim;
    // Show pending finals too, so words don't vanish between recognition and the coalesced flush.
    args.onInterim([...pending, interim].join(" ").trim());
    if (pending.length > 0) {
      clearTimeout(timer);
      timer = setTimeout(flush, args.coalesceMs ?? FINAL_COALESCE_MS);
    }
  };

  recognition.onerror = (event) => {
    // Silence and our own stop() are not failures.
    if (event.error === "no-speech" || event.error === "aborted") return;
    fail(speechErrorMessage(event.error));
  };

  // Chromium ends continuous sessions after a pause; restart until the user stops the mic.
  recognition.onend = () => {
    if (stopped) return;
    try {
      recognition.start();
    } catch (error) {
      fail(`Speech-to-text stopped: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  recognition.start();

  return () => {
    stopped = true;
    interim = "";
    flush();
    recognition.onend = null;
    recognition.stop();
  };
}
