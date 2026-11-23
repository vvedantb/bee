import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { holdQuitForSave } from "./quit-save";

function fakeApp() {
  let listener: ((event: { preventDefault: () => void }) => void) | undefined;
  const app = {
    quits: 0,
    prevented: 0,
    on: (_event: "before-quit", next: (event: { preventDefault: () => void }) => void) => {
      listener = next;
    },
    quit: () => app.request(),
    // A quit as Electron runs it: before-quit, then the app quits unless a listener prevented it.
    request: () => {
      let prevented = false;
      listener?.({ preventDefault: () => void (prevented = true) });
      if (prevented) app.prevented += 1;
      else app.quits += 1;
    },
  };
  return app;
}

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe("holdQuitForSave", () => {
  it("holds the quit until the meeting is saved, then quits once", async () => {
    const app = fakeApp();
    let finish = () => undefined as void;
    const save = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    holdQuitForSave({ app, save });
    app.request();
    app.request();
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(1);
    expect(app.quits).toBe(0);
    finish();
    await vi.runAllTimersAsync();
    expect(app.quits).toBe(1);
  });

  it("quits anyway when the save hangs or fails", async () => {
    const app = fakeApp();
    const outcomes: string[] = [];
    holdQuitForSave({ app, save: () => new Promise(() => undefined), timeoutMs: 1000, onDone: (outcome) => void outcomes.push(outcome) });
    app.request();
    await vi.advanceTimersByTimeAsync(1000);
    expect(app.quits).toBe(1);

    const failing = fakeApp();
    holdQuitForSave({ app: failing, save: async () => Promise.reject(new Error("no window")), onDone: (outcome) => void outcomes.push(outcome) });
    failing.request();
    await vi.runAllTimersAsync();
    expect(failing.quits).toBe(1);
    expect(outcomes).toEqual(["timeout", "failed"]);
  });
});
