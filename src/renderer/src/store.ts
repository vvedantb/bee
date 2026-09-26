import { useSyncExternalStore } from "react";
import type { PipelineResult, SettingsUpdate, SettingsView } from "../../shared/ipc";

// App-wide state shared by the notch and the panel. Local form input stays in the DOM (uncontrolled forms).
export type BeeState = {
  settings: SettingsView | null;
  expanded: boolean;
  transcript: string[];
  result: PipelineResult | null;
  busy: boolean;
  error: string | null;
  mic: { on: boolean; level: number; error: string | null };
};

const TRANSCRIPT_LIMIT = 50;
const PIPELINE_WINDOW = 8;

export const SAMPLE_LINES = [
  "Let's pick up the Acme renewal. They are asking for a bigger discount.",
  "Could we go to twenty percent off if they sign this week?",
  "Also, when does SSO ship for enterprise customers?",
  "Separately, what salary band are we offering the backend candidate?",
];

let state: BeeState = {
  settings: null,
  expanded: false,
  transcript: [],
  result: null,
  busy: false,
  error: null,
  mic: { on: false, level: 0, error: null },
};
const listeners = new Set<() => void>();

function set(patch: Partial<BeeState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBee(): BeeState {
  return useSyncExternalStore(subscribe, () => state);
}

let latestRun = 0;
let sampleIndex = 0;
let stopMic: (() => void) | null = null;

export const actions = {
  async refreshSettings(): Promise<void> {
    set({ settings: await window.bee.getSettings() });
  },

  async saveSettings(update: SettingsUpdate): Promise<void> {
    try {
      set({ settings: await window.bee.saveSettings(update), error: null });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : "Could not save settings" });
    }
  },

  async setExpanded(expanded: boolean): Promise<void> {
    await window.bee.setExpanded(expanded);
    set({ expanded });
  },

  nextSampleLine(): string {
    const line = SAMPLE_LINES[sampleIndex % SAMPLE_LINES.length] ?? "";
    sampleIndex += 1;
    return line;
  },

  /** Stub for live speech-to-text: inject a transcript line and run retrieve → Jev → Luna. */
  async simulateLine(line: string): Promise<void> {
    const text = line.trim();
    if (!text) return;
    const transcript = [...state.transcript, text].slice(-TRANSCRIPT_LIMIT);
    const run = ++latestRun;
    set({ transcript, busy: true, error: null });
    try {
      const result = await window.bee.runPipeline({ transcript: transcript.slice(-PIPELINE_WINDOW) });
      if (run === latestRun) set({ result, busy: false });
    } catch (error) {
      if (run === latestRun) set({ busy: false, error: error instanceof Error ? error.message : "Pipeline failed" });
    }
  },

  clearTranscript(): void {
    latestRun += 1;
    set({ transcript: [], result: null, busy: false, error: null });
  },

  /** Mic capture with a level meter. Transcription is stubbed in v1. */
  async toggleMic(): Promise<void> {
    if (stopMic) {
      stopMic();
      stopMic = null;
      set({ mic: { on: false, level: 0, error: null } });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      let frame = 0;
      let raf = 0;
      const tick = (): void => {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
        // Re-render at ~10 fps, not every animation frame.
        if (frame++ % 6 === 0) set({ mic: { on: true, level: Math.min(1, Math.sqrt(sum / samples.length) * 4), error: null } });
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      stopMic = () => {
        cancelAnimationFrame(raf);
        for (const track of stream.getTracks()) track.stop();
        void context.close();
      };
      set({ mic: { on: true, level: 0, error: null } });
    } catch (error) {
      set({ mic: { on: false, level: 0, error: error instanceof Error ? error.message : "Microphone unavailable" } });
    }
  },
};

void actions.refreshSettings();
