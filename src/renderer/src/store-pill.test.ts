import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PILL_MAX } from "../../core/overlay-size";
import type { WindowRequest } from "../../shared/ipc";

// The compact pill (store.ts applyWindowSize): the window widens before the pill eases out, and the pill eases in before
// the window narrows. The pill keeps its measured width when the body or panel opens under it; only the window widens. Preload (window.bee) and Clerk are stubbed; motion is full (no document), so the morph waits 380 ms.
vi.mock("@clerk/electron/react", () => ({ getToken: async () => "token" }));

// Each step in order: what main was asked for, and each new pill width.
type Step = { sent: WindowRequest } | { island: number };

async function loadStore() {
  const steps: Step[] = [];
  vi.stubGlobal("window", {
    bee: {
      getSettings: async () => null,
      mcp: { list: async () => [] },
      checkForUpdate: async () => ({ currentVersion: "0.0.0", latestVersion: null, available: false, error: null }),
      setWindowSize: async (request: WindowRequest) => {
        steps.push({ sent: request });
      },
    },
  });
  const store = await import("./store");
  let island = store.getBeeState().pillWidth;
  store.subscribe(() => {
    const width = store.getBeeState().pillWidth;
    if (width !== island) steps.push({ island: width });
    island = width;
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

  it("narrows to the measured header, island first, then the window after the morph", async () => {
    const { store, steps } = await loadStore();
    store.actions.measurePill(289);
    expect(steps).toEqual([{ island: 296 }]);
    await vi.advanceTimersByTimeAsync(379);
    expect(steps).toEqual([{ island: 296 }]);
    await vi.advanceTimersByTimeAsync(1);
    expect(steps).toEqual([{ island: 296 }, { sent: { size: "collapsed", width: 296 } }]);
  });

  it("sends nothing for a change inside the same 8 px step", async () => {
    const { store, steps } = await loadStore();
    store.actions.measurePill(289);
    await vi.advanceTimersByTimeAsync(400);
    steps.length = 0;
    store.actions.measurePill(293);
    await vi.advanceTimersByTimeAsync(400);
    expect(steps).toEqual([]);
  });

  it("widens only the window when a response opens, keeping the pill compact, and narrows it at once after it closes", async () => {
    const { store, steps } = await loadStore();
    store.actions.measurePill(289);
    await vi.advanceTimersByTimeAsync(400);
    steps.length = 0;

    store.actions.openAsk();
    await vi.advanceTimersByTimeAsync(0);
    expect(steps).toEqual([{ sent: { size: "response", width: PILL_MAX } }]);
    expect(store.getBeeState().pillWidth).toBe(296);

    steps.length = 0;
    store.actions.closeAsk();
    await vi.advanceTimersByTimeAsync(0);
    // The pill has nothing to ease, so the window does not wait for a morph.
    expect(steps).toEqual([{ sent: { size: "collapsed", width: 296 } }]);
  });

  it("keeps the pill compact when the panel opens", async () => {
    const { store, steps } = await loadStore();
    store.actions.measurePill(289);
    await vi.advanceTimersByTimeAsync(400);
    steps.length = 0;
    await store.actions.setExpanded(true);
    expect(steps).toEqual([{ sent: { size: "expanded", width: PILL_MAX } }]);
    expect(store.getBeeState().pillWidth).toBe(296);
  });

  it("a response that opens mid-morph keeps the window wide and the pill at its new width", async () => {
    const { store, steps } = await loadStore();
    store.actions.measurePill(289);
    await vi.advanceTimersByTimeAsync(100);
    store.actions.openAsk();
    await vi.advanceTimersByTimeAsync(1000);
    expect(steps).toEqual([{ island: 296 }, { sent: { size: "response", width: PILL_MAX } }]);
  });
});
