import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WindowSize } from "../../shared/ipc";

// The compact pill (store.ts measurePill, applyWindowSize): its width is CSS only. Measuring it never resizes the window, and
// a response or the panel opening under it changes only the window's mode (main changes only the height). Preload
// (window.bee) and Clerk are stubbed.
vi.mock("@clerk/electron/react", () => ({ getToken: async () => "token" }));

// Each step in order: a mode sent to main, or a new pill width.
type Step = { sent: WindowSize } | { pill: number };

async function loadStore() {
  const steps: Step[] = [];
  vi.stubGlobal("window", {
    bee: {
      getSettings: async () => null,
      mcp: { list: async () => [] },
      checkForUpdate: async () => ({ currentVersion: "0.0.0", latestVersion: null, available: false, error: null }),
      setWindowSize: async (size: WindowSize) => {
        steps.push({ sent: size });
      },
    },
  });
  const store = await import("./store");
  let pill = store.getBeeState().pillWidth;
  store.subscribe(() => {
    const width = store.getBeeState().pillWidth;
    if (width !== pill) steps.push({ pill: width });
    pill = width;
  });
  await vi.advanceTimersByTimeAsync(0);
  return { store, steps };
}

describe("store: compact pill", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("sets the snapped pill width at once and never resizes the window for it", async () => {
    const { store, steps } = await loadStore();
    store.actions.measurePill(289);
    store.actions.measurePill(293);
    await vi.advanceTimersByTimeAsync(1000);
    expect(steps).toEqual([{ pill: 296 }]);
  });

  it("sends only the mode when a response or the panel opens, and keeps the pill compact", async () => {
    const { store, steps } = await loadStore();
    store.actions.measurePill(289);
    steps.length = 0;

    store.actions.openAsk();
    await vi.advanceTimersByTimeAsync(0);
    store.actions.closeAsk();
    await vi.advanceTimersByTimeAsync(0);
    await store.actions.setExpanded(true);
    expect(steps).toEqual([{ sent: "response" }, { sent: "collapsed" }, { sent: "expanded" }]);
    expect(store.getBeeState().pillWidth).toBe(296);
  });
});
