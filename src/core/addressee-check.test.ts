import { describe, expect, it, vi } from "vitest";
import fixture from "../../test/fixtures/addressee/cases.json";
import { decideAddressee, prefilterAddressee, type AddresseeInput } from "./addressee-check";
import { ADDRESSEE_CHECK_DEFAULT, ADDRESSEE_THRESHOLD_DEFAULT, clampAddresseeThreshold } from "./addressee-settings";
import { debugLog } from "./debug-log";
import type { FollowUpVerdict } from "./wake-word";

type Phrase = { phrase: string; lines: readonly string[] };
const FOLLOW_UP: Phrase = { phrase: "the Q3 tab please", lines: [] };

const input = (item: Phrase): AddresseeInput => ({
  phrase: item.phrase,
  lastBee: fixture.lastBee,
  lines: item.lines,
  participants: fixture.participants,
  conversationOpen: true,
  othersQuiet: true,
});

describe("addressee check settings", () => {
  it("is on at 0.7 by default, and clamps to 0.5 to 0.95", () => {
    expect(ADDRESSEE_CHECK_DEFAULT).toBe(true);
    expect(ADDRESSEE_THRESHOLD_DEFAULT).toBe(0.7);
    expect(clampAddresseeThreshold(0.1)).toBe(0.5);
    expect(clampAddresseeThreshold(2)).toBe(0.95);
    expect(clampAddresseeThreshold("0.9")).toBe(0.7);
    expect(clampAddresseeThreshold(Number.NaN)).toBe(0.7);
  });
});

describe("prefilterAddressee", () => {
  it.each(fixture.cases)("$id", (item) => {
    const result = prefilterAddressee(input(item));
    expect(result.runModel).toBe(item.prefilter === "run");
    if ("reason" in item) expect(result.reason).toBe(item.reason);
  });

  it("skips with no Bee exchange or a closed window", () => {
    expect(prefilterAddressee({ ...input(FOLLOW_UP), lastBee: null })).toEqual({ runModel: false, reason: "no-exchange" });
    expect(prefilterAddressee({ ...input(FOLLOW_UP), conversationOpen: false })).toEqual({ runModel: false, reason: "conversation-closed" });
  });
});

describe("decideAddressee", () => {
  it.each(fixture.cases)("$id", async (item) => {
    const classify = vi.fn(async (): Promise<FollowUpVerdict | null> => (item.model as FollowUpVerdict | null | undefined) ?? null);
    const result = await decideAddressee({ input: input(item), enabled: true, classify });
    expect(result.decision).toBe(item.decision);
    // The model runs only when the prefilter passes.
    expect(classify).toHaveBeenCalledTimes(item.prefilter === "run" ? 1 : 0);
    expect(result.threshold).toBe(0.7);
  });

  it("never calls the model when disabled, and stays a meeting line", async () => {
    const classify = vi.fn(async (): Promise<FollowUpVerdict | null> => ({ addressed: "bee", confidence: 1 }));
    const result = await decideAddressee({ input: input(FOLLOW_UP), enabled: false, classify });
    expect(result).toMatchObject({ decision: "meeting", reason: "disabled", score: null });
    expect(classify).not.toHaveBeenCalled();
  });

  it("treats a thrown model call as a meeting line", async () => {
    const result = await decideAddressee({ input: input(FOLLOW_UP), enabled: true, classify: async () => Promise.reject(new Error("boom")) });
    expect(result).toMatchObject({ decision: "meeting", reason: "model-failed", score: null });
  });

  it("acts at the threshold, not below it, and follows a changed threshold", async () => {
    const classify = async (): Promise<FollowUpVerdict | null> => ({ addressed: "bee", confidence: 0.7 });
    expect((await decideAddressee({ input: input(FOLLOW_UP), enabled: true, classify })).decision).toBe("bee");
    expect((await decideAddressee({ input: input(FOLLOW_UP), enabled: true, threshold: 0.8, classify })).decision).toBe("meeting");
    // Out of range reads as the bound: 0.1 becomes 0.5.
    expect((await decideAddressee({ input: input(FOLLOW_UP), enabled: true, threshold: 0.1, classify: async () => ({ addressed: "bee", confidence: 0.55 }) })).threshold).toBe(0.5);
  });

  it("logs each decision with the score, threshold and latency, and never the full phrase or a key", async () => {
    const info = vi.spyOn(debugLog, "info").mockImplementation(() => undefined);
    const long = { ...FOLLOW_UP, phrase: "the Q3 tab please and then also scroll down to the very bottom of the page" };
    await decideAddressee({ input: input(long), enabled: true, classify: async () => ({ addressed: "bee", confidence: 0.9 }) });
    const call = info.mock.calls.find((args) => args[1] === "decision");
    info.mockRestore();
    const data = call?.[2];
    expect(call?.[0]).toBe("addressee");
    expect(data).toMatchObject({ prefilter: { runModel: true }, score: 0.9, threshold: 0.7, decision: "bee", latencyMs: expect.any(Number) });
    expect(JSON.stringify(data)).not.toContain("scroll down to the very bottom");
  });
});
