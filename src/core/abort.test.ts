import { describe, expect, it } from "vitest";
import { withTimeout } from "./abort";

describe("withTimeout", () => {
  it("times out on its own without a caller signal", async () => {
    const signal = withTimeout(undefined, 20);
    expect(signal.aborted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(signal.aborted).toBe(true);
  });

  it("aborts at once when the caller's signal fires", () => {
    const controller = new AbortController();
    const signal = withTimeout(controller.signal, 60_000);
    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });

  it("is already aborted for an aborted caller signal", () => {
    expect(withTimeout(AbortSignal.abort(), 60_000).aborted).toBe(true);
  });
});
