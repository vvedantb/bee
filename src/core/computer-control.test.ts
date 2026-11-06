import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESSIBILITY_LINE, ComputerStopped, LINUX_A11Y_LINE, awaitAnswer, createRunControl, stopLine } from "./computer-control";

// Computer use's loop controls with fake timers: steps, the wall clock (paused while a Confirm waits), and stop.

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("createRunControl", () => {
  it("allows the step limit, then stops on the next step", () => {
    const control = createRunControl({ maxSteps: 3 });
    expect([control.step(), control.step(), control.step()]).toEqual([true, true, true]);
    expect(control.signal.aborted).toBe(false);
    expect(control.step()).toBe(false);
    expect(control.reason()).toBe("steps");
    expect(control.signal.aborted).toBe(true);
    expect(control.signal.reason).toBeInstanceOf(ComputerStopped);
    expect(control.steps()).toBe(3);
    control.dispose();
  });

  it("stops when the time is up", async () => {
    const control = createRunControl({ maxMs: 10_000 });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(control.reason()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(control.reason()).toBe("time");
    expect(control.signal.aborted).toBe(true);
    expect(control.step()).toBe(false);
  });

  it("does not count time spent waiting for a Confirm tap", async () => {
    const control = createRunControl({ maxMs: 10_000 });
    await vi.advanceTimersByTimeAsync(6_000);
    const waiting = control.paused(() => new Promise((resolve) => setTimeout(resolve, 50_000)));
    await vi.advanceTimersByTimeAsync(50_000);
    await waiting;
    expect(control.reason()).toBeNull();
    await vi.advanceTimersByTimeAsync(3_999);
    expect(control.reason()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(control.reason()).toBe("time");
  });

  it("stops at once for the user, keeps the first reason, and stops with its parent signal", () => {
    const control = createRunControl();
    control.stop("user");
    control.stop("time");
    expect(control.reason()).toBe("user");
    expect(control.step()).toBe(false);
    const parent = new AbortController();
    const child = createRunControl({ signal: parent.signal });
    parent.abort();
    expect(child.reason()).toBe("user");
    expect(createRunControl({ signal: parent.signal }).reason()).toBe("user");
  });

  it("keeps what the user did not confirm", () => {
    const control = createRunControl();
    control.stop("declined", "send");
    expect([control.reason(), control.declined()]).toEqual(["declined", "send"]);
  });

  it("has no step limit by default: only a stop ends it", () => {
    const control = createRunControl();
    for (let index = 0; index < 500; index += 1) expect(control.step()).toBe(true);
    expect(control.reason()).toBeNull();
    control.stop("loop");
    expect(control.step()).toBe(false);
    expect(control.reason()).toBe("loop");
    control.dispose();
  });
});

describe("awaitAnswer", () => {
  it("is true only for a Confirm, and tells the asker once it is settled", async () => {
    let settled: AbortSignal | null = null;
    const yes = awaitAnswer(async (signal) => {
      settled = signal;
      return true;
    }, new AbortController().signal);
    expect(await yes).toBe(true);
    expect((settled as AbortSignal | null)?.aborted).toBe(true);
    expect(await awaitAnswer(async () => false, new AbortController().signal)).toBe(false);
    expect(await awaitAnswer(() => Promise.reject(new Error("window gone")), new AbortController().signal)).toBe(false);
  });

  it("reads no answer in time, or a stop, as Cancel", async () => {
    const never = () => new Promise<boolean>(() => undefined);
    const late = awaitAnswer(never, new AbortController().signal, 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await late).toBe(false);
    const stop = new AbortController();
    const stopped = awaitAnswer(never, stop.signal, 60_000);
    stop.abort();
    expect(await stopped).toBe(false);
    expect(await awaitAnswer(never, stop.signal)).toBe(false);
  });
});

describe("stopLine", () => {
  it("ends a stopped run with one short line", () => {
    expect(stopLine("user")).toBe("Stopped.");
    expect(stopLine("steps", { maxSteps: 12 })).toBe("Stopped after 12 steps.");
    expect(stopLine("steps")).toBe("Stopped.");
    expect(stopLine("loop")).toBe("Stopped: Bee kept repeating the same step.");
    expect(stopLine("time")).toBe("Stopped: that took too long.");
    expect(stopLine("permission", { platform: "mac" })).toBe(ACCESSIBILITY_LINE);
    expect(stopLine("permission", { platform: "linux" })).toBe(LINUX_A11Y_LINE);
    expect(LINUX_A11Y_LINE).toContain("AT-SPI");
    expect(stopLine("permission", { platform: "windows" })).toMatch(/administrator/);
    expect(stopLine("declined", { declined: "send" })).toBe("Cancelled. Nothing was sent.");
    expect(stopLine("declined", { declined: "delete" })).toBe("Cancelled. Nothing was deleted.");
    for (const reason of ["user", "steps", "time", "permission", "declined", "loop"] as const) expect(stopLine(reason)).not.toMatch(/claude|haiku|anthropic|clerk/i);
  });
});
