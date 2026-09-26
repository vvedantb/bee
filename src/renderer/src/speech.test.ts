import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FINAL_COALESCE_MS, startSpeech, type Recognition, type RecognitionEvent, type RecognitionResult } from "./speech";

class MockRecognition implements Recognition {
  static last: MockRecognition | null = null;
  continuous = false;
  interimResults = false;
  lang = "";
  onresult: ((event: RecognitionEvent) => void) | null = null;
  onerror: ((event: { readonly error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  starts = 0;
  stops = 0;

  constructor() {
    MockRecognition.last = this;
  }

  start(): void {
    this.starts += 1;
  }

  stop(): void {
    this.stops += 1;
  }

  emit(results: Array<[string, boolean]>, resultIndex = 0): void {
    const list: RecognitionResult[] = results.map(([transcript, isFinal]) => ({ isFinal, length: 1, 0: { transcript } }));
    this.onresult?.({ resultIndex, results: list });
  }
}

function recognition(): MockRecognition {
  const current = MockRecognition.last;
  if (!current) throw new Error("recognition not started");
  return current;
}

function start() {
  const handlers = { onInterim: vi.fn<(text: string) => void>(), onFinal: vi.fn<(line: string) => void>(), onError: vi.fn<(message: string) => void>() };
  const stop = startSpeech({ Recognition: MockRecognition, ...handlers });
  return { ...handlers, stop };
}

beforeEach(() => {
  vi.useFakeTimers();
  MockRecognition.last = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startSpeech", () => {
  it("starts continuous English recognition with interim results", () => {
    start();
    expect(recognition()).toMatchObject({ continuous: true, interimResults: true, lang: "en-US", starts: 1 });
  });

  it("shows interim text without forwarding it", () => {
    const { onInterim, onFinal } = start();
    recognition().emit([["last time we", false]]);
    expect(onInterim).toHaveBeenLastCalledWith("last time we");
    vi.advanceTimersByTime(FINAL_COALESCE_MS * 2);
    expect(onFinal).not.toHaveBeenCalled();
  });

  it("coalesces rapid finals into one line for the pipeline", () => {
    const { onFinal, onInterim } = start();
    recognition().emit([["Last time we discussed", true]]);
    vi.advanceTimersByTime(FINAL_COALESCE_MS / 2);
    recognition().emit([["Last time we discussed", true], [" the Acme renewal ", true]], 1);
    expect(onInterim).toHaveBeenLastCalledWith("Last time we discussed the Acme renewal");
    expect(onFinal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(FINAL_COALESCE_MS);
    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onFinal).toHaveBeenCalledWith("Last time we discussed the Acme renewal");
    expect(onInterim).toHaveBeenLastCalledWith("");
  });

  it("forwards separate utterances separately", () => {
    const { onFinal } = start();
    recognition().emit([["First point.", true]]);
    vi.advanceTimersByTime(FINAL_COALESCE_MS);
    recognition().emit([["Second point.", true]]);
    vi.advanceTimersByTime(FINAL_COALESCE_MS);
    expect(onFinal.mock.calls).toEqual([["First point."], ["Second point."]]);
  });

  it("restarts after Chromium ends the session, and stop() flushes pending text", () => {
    const { onFinal, stop } = start();
    recognition().onend?.();
    expect(recognition().starts).toBe(2);
    recognition().emit([["Wrap up", true]]);
    stop();
    expect(onFinal).toHaveBeenCalledWith("Wrap up");
    expect(recognition().stops).toBe(1);
    recognition().onend?.();
    expect(recognition().starts).toBe(2);
  });

  it("reports real errors clearly and ignores silence", () => {
    const { onError } = start();
    recognition().onerror?.({ error: "no-speech" });
    expect(onError).not.toHaveBeenCalled();
    recognition().onerror?.({ error: "network" });
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("network"));
    recognition().onend?.();
    expect(recognition().starts).toBe(1);
  });
});
