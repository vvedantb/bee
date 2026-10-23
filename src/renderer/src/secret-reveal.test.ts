import { describe, expect, it, vi } from "vitest";
import { clearIfCurrent, createRevealGuard } from "./secret-reveal";

describe("clearIfCurrent", () => {
  it("clears the token it was made for", () => {
    const token = { value: "a" };
    expect(clearIfCurrent(token)(token)).toBeNull();
  });

  it("keeps a newer value and an already cleared one", () => {
    const old = { value: "a" };
    const next = { value: "a" };
    expect(clearIfCurrent(old)(next)).toBe(next);
    expect(clearIfCurrent(old)(null)).toBeNull();
  });
});

describe("createRevealGuard", () => {
  it("drops a reveal that resolves after cancel (Replace or hide)", () => {
    const guard = createRevealGuard();
    const current = guard.begin();
    expect(current()).toBe(true);
    guard.cancel();
    expect(current()).toBe(false);
  });

  it("only the newest reveal stays current", () => {
    const guard = createRevealGuard();
    const first = guard.begin();
    const second = guard.begin();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it("dispose drops in-flight reveals and clears pending timers", () => {
    vi.useFakeTimers();
    try {
      const guard = createRevealGuard();
      const current = guard.begin();
      const run = vi.fn();
      guard.later(run, 1_000);
      guard.unmountRef()();
      vi.advanceTimersByTime(1_000);
      expect(run).not.toHaveBeenCalled();
      expect(current()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs timers that are not disposed", () => {
    vi.useFakeTimers();
    try {
      const guard = createRevealGuard();
      const run = vi.fn();
      guard.later(run, 1_000);
      vi.advanceTimersByTime(1_000);
      expect(run).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
