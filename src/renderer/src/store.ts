import { getToken } from "@clerk/electron/react";
import { useSyncExternalStore } from "react";
import type { PipelineResult, SettingsUpdate, SettingsView, UpdateCheck } from "../../shared/ipc";
import { startSpeech, type RecognitionConstructor } from "./speech";

export type Tab = "live" | "settings";

// ready: the installer is downloaded. check: the last successful check, kept while downloading.
export type UpdateState = {
  status: "idle" | "checking" | "downloading" | "ready";
  check: UpdateCheck | null;
  error: string | null;
};

// App-wide state shared by the notch and the panel. Local form input stays in the DOM (uncontrolled forms).
export type BeeState = {
  settings: SettingsView | null;
  expanded: boolean;
  // True while the panel plays its exit animation, before the window shrinks.
  collapsing: boolean;
  tab: Tab;
  transcript: string[];
  result: PipelineResult | null;
  busy: boolean;
  error: string | null;
  // interim: words the recogniser has heard but not yet finalised.
  mic: { on: boolean; level: number; interim: string; error: string | null };
  update: UpdateState;
};

const TRANSCRIPT_LIMIT = 50;
const PIPELINE_WINDOW = 8;
// Matches the panel exit animation in styles.css.
const COLLAPSE_MS = 160;
const MIC_OFF = { on: false, level: 0, interim: "" };

export const SAMPLE_LINES = [
  "Let's pick up the Acme renewal. They are asking for a bigger discount.",
  "Could we go to twenty percent off if they sign this week?",
  "Also, when does SSO ship for enterprise customers?",
  "Separately, what salary band are we offering the backend candidate?",
];

let state: BeeState = {
  settings: null,
  expanded: false,
  collapsing: false,
  tab: "live",
  transcript: [],
  result: null,
  busy: false,
  error: null,
  mic: { ...MIC_OFF, error: null },
  update: { status: "idle", check: null, error: null },
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

function speechRecognition(): RecognitionConstructor | null {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

function setUpdate(patch: Partial<UpdateState>): void {
  set({ update: { ...state.update, ...patch } });
}

function setMic(patch: Partial<BeeState["mic"]>): void {
  set({ mic: { ...state.mic, ...patch } });
}

export const actions = {
  async refreshSettings(): Promise<void> {
    set({ settings: await window.bee.getSettings() });
  },

  /** Resolves true when saved. */
  async saveSettings(update: SettingsUpdate): Promise<boolean> {
    try {
      set({ settings: await window.bee.saveSettings(update), error: null });
      return true;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : "Could not save settings" });
      return false;
    }
  },

  async setExpanded(expanded: boolean): Promise<void> {
    if (expanded) {
      set({ collapsing: false });
      await window.bee.setExpanded(true);
      set({ expanded: true });
      return;
    }
    // Let the panel fade out before the window shrinks under it.
    set({ collapsing: true });
    await new Promise((resolve) => setTimeout(resolve, COLLAPSE_MS));
    if (!state.collapsing) return;
    await window.bee.setExpanded(false);
    set({ expanded: false, collapsing: false });
  },

  setTab(tab: Tab): void {
    set({ tab });
  },

  async openSettings(): Promise<void> {
    set({ tab: "settings" });
    if (!state.expanded) await actions.setExpanded(true);
  },

  nextSampleLine(): string {
    const line = SAMPLE_LINES[sampleIndex % SAMPLE_LINES.length] ?? "";
    sampleIndex += 1;
    return line;
  },

  /** Append a transcript line (typed, or a final from speech-to-text) and run retrieve → Jev → Luna. */
  async simulateLine(line: string): Promise<void> {
    const text = line.trim();
    if (!text) return;
    const transcript = [...state.transcript, text].slice(-TRANSCRIPT_LIMIT);
    const run = ++latestRun;
    set({ transcript, busy: true, error: null });
    try {
      const sessionToken = await getToken();
      if (!sessionToken) throw new Error("Sign in to Bee to get guidance.");
      const result = await window.bee.runPipeline({ transcript: transcript.slice(-PIPELINE_WINDOW), sessionToken });
      if (run === latestRun) set({ result, busy: false });
    } catch (error) {
      if (run === latestRun) set({ busy: false, error: error instanceof Error ? error.message : "Pipeline failed" });
    }
  },

  clearTranscript(): void {
    latestRun += 1;
    set({ transcript: [], result: null, busy: false, error: null });
  },

  /** Mic on: Web Speech transcription feeds finals into simulateLine, plus a level meter. */
  async toggleMic(): Promise<void> {
    if (stopMic) {
      actions.stopMic(null);
      return;
    }
    const Recognition = speechRecognition();
    if (!Recognition) {
      setMic({ ...MIC_OFF, error: "Speech-to-text is not available here (no Web Speech API). Use Simulate meeting line." });
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
        if (frame++ % 6 === 0) setMic({ level: Math.min(1, Math.sqrt(sum / samples.length) * 4) });
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      const stopSpeech = startSpeech({
        Recognition,
        onInterim: (interim) => setMic({ interim }),
        // Same path as a typed line; latestRun drops results from superseded runs.
        onFinal: (line) => void actions.simulateLine(line),
        onError: (message) => actions.stopMic(message),
      });
      stopMic = () => {
        stopSpeech();
        cancelAnimationFrame(raf);
        for (const track of stream.getTracks()) track.stop();
        void context.close();
      };
      set({ mic: { on: true, level: 0, interim: "", error: null } });
    } catch (error) {
      setMic({ ...MIC_OFF, error: `Microphone unavailable: ${error instanceof Error ? error.message : String(error)}` });
    }
  },

  stopMic(error: string | null): void {
    const stop = stopMic;
    stopMic = null;
    stop?.();
    set({ mic: { ...MIC_OFF, error } });
  },

  async checkForUpdate(): Promise<void> {
    setUpdate({ status: "checking", error: null });
    const check = await window.bee.checkForUpdate();
    if (check.error) setUpdate({ status: "idle", error: check.error });
    else setUpdate({ status: "idle", check, error: null });
  },

  async downloadUpdate(): Promise<void> {
    setUpdate({ status: "downloading", error: null });
    const { error } = await window.bee.downloadUpdate();
    setUpdate({ status: error ? "idle" : "ready", error });
  },

  async installUpdate(): Promise<void> {
    const { error } = await window.bee.installUpdate();
    setUpdate({ error });
  },
};

void actions.refreshSettings();
// Quiet check at start-up; the notch shows an update button only when one is available.
void actions.checkForUpdate();
