import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { SettingsUpdate, SettingsView, TranscribeResult, WindowSize } from "../../shared/ipc";
import { HINT_TEXT, NO_INPUT_MS } from "./hints";

// Mic hints in the store: the real segmenter and hint detector, fed synthetic frames through a stubbed mic. Preload (window.bee)
// and Clerk are stubbed; speech-to-text never returns words, and the frames are flat levels, never speech.
vi.mock("@clerk/electron/react", () => ({ getToken: async () => "token" }));
let onFrame: ((frame: Float32Array) => void) | null = null;
vi.mock("./mic", () => ({
  openMic: async () => ({
    sampleRate: 48_000,
    start: (listener: (frame: Float32Array) => void) => {
      onFrame = listener;
    },
    stop: () => {
      onFrame = null;
    },
  }),
}));

// 4096 samples at 48 kHz (mic.ts).
const FRAME_MS = 85;
const QUIET = 0.02;
const NORMAL = 0.1;
const HISS = 0.0005;

const SETTINGS: SettingsView = {
  gatewayKeySource: "saved",
  personalisedLinks: false,
  vmemConnected: false,
  sendSessionsToVmem: false,
  meetingMode: false,
  interfaceScale: 1,
  motionPreference: "on",
  secretStorage: "os",
  notesDir: "/notes",
  logsDir: "/logs",
  knownNames: [],
  teamsAudioFallbackEnabled: false,
  toggleShortcut: "CommandOrControl+Shift+Space",
  toggleShortcutActive: true,
};

async function loadStore(settings: Partial<SettingsView> = {}) {
  let saved: SettingsView = { ...SETTINGS, ...settings };
  const sizes: WindowSize[] = [];
  vi.stubGlobal("window", {
    bee: {
      getSettings: async () => saved,
      saveSettings: async (update: SettingsUpdate) => {
        saved = { ...saved, ...update } as SettingsView;
        return saved;
      },
      mcp: { list: async () => [] },
      checkForUpdate: async () => ({ currentVersion: "0.0.0", latestVersion: null, available: false, error: null }),
      setWindowSize: async (size: WindowSize) => {
        sizes.push(size);
      },
      transcribe: async (): Promise<TranscribeResult> => ({ text: null, error: null }),
    },
  });
  const store = await import("./store");
  // Each hint the store shows, in order.
  const seen: string[] = [];
  store.subscribe(() => {
    const id = store.getBeeState().hint?.id;
    if (id && !store.getBeeState().hintClosing && id !== seen.at(-1)) seen.push(id);
  });
  await vi.advanceTimersByTimeAsync(0);
  await store.actions.toggleMic();
  /** Frames at a flat level for `ms`, in real frame steps. */
  const frames = async (ms: number, level: number | ((at: number) => number)) => {
    for (let at = 0; at < ms; at += FRAME_MS) {
      onFrame?.(new Float32Array(4096).fill(typeof level === "number" ? level : level(at)));
      await vi.advanceTimersByTimeAsync(FRAME_MS);
    }
  };
  return { store, frames, sizes, seen, state: () => store.getBeeState() };
}

describe("store: mic hints", () => {
  let debug: MockInstance<typeof console.debug>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    onFrame = null;
    debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
  });

  afterEach(() => {
    debug.mockRestore();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("opens the island for a quiet voice, as guidance and never as a mic error", async () => {
    const { store, frames, sizes, state } = await loadStore();
    const { logoState } = await import("./notch");
    await frames(4000, QUIET);
    expect(state().hint).toBeNull();
    await frames(1500, QUIET);
    expect(state().hint).toEqual({ id: "quiet", text: HINT_TEXT.quiet });
    expect(state().mic.error).toBeNull();
    expect(logoState(state())).toBe("listening");
    expect(store.islandOpen(state())).toBe(true);
    expect(store.responseOpen(state())).toBe(false);
    expect(sizes.at(-1)).toBe("response");
  });

  it("closes the hint alone from the island's dismiss button, and keeps it away for its cooldown", async () => {
    const { store, frames, sizes, seen, state } = await loadStore();
    await frames(5500, QUIET);
    const closing = store.actions.dismissIsland();
    expect(state().hintClosing).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    await closing;
    expect(state()).toMatchObject({ hint: null, hintClosing: false, dismissed: false });
    expect(sizes.at(-1)).toBe("collapsed");
    // A minute more of flat quiet sound: quiet stays away. (The stub's empty transcripts may bring noisy, a different hint.)
    await frames(60_000, QUIET);
    expect(seen.filter((id) => id === "quiet")).toHaveLength(1);
  });

  it("hides the hint by itself after its time on screen", async () => {
    const { frames, sizes, state } = await loadStore();
    await frames(5500, QUIET);
    expect(state().hint?.id).toBe("quiet");
    await frames(16_000, NORMAL);
    expect(state().hint).toBeNull();
    expect(sizes.at(-1)).toBe("collapsed");
  });

  it("shows no input after a long silence, and drops it when the mic turns off", async () => {
    const { store, frames, state } = await loadStore();
    await frames(NO_INPUT_MS + 500, 0);
    expect(state().hint?.id).toBe("no-input");
    await store.actions.toggleMic();
    await vi.advanceTimersByTimeAsync(300);
    expect(state().hint).toBeNull();
    expect(state().mic.on).toBe(false);
  });

  it("counts phrases that come back with no words, and shows noisy", async () => {
    const { frames, state } = await loadStore();
    // Short phrases at a normal level, each ended by a pause: the segmenter sends each one to speech-to-text.
    for (let phrase = 0; phrase < 5; phrase += 1) {
      await frames(600, NORMAL);
      await frames(1200, HISS);
    }
    expect(state().hint).toEqual({ id: "noisy", text: HINT_TEXT.noisy });
  });

  it("logs hint ids and seconds on screen only", async () => {
    const { frames } = await loadStore();
    await frames(5500, QUIET);
    await frames(16_000, NORMAL);
    const lines = debug.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith("Bee: mic hint"));
    expect(lines).toEqual(["Bee: mic hint quiet", "Bee: mic hint quiet hidden after 15 s"]);
  });
});
