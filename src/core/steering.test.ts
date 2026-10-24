import { describe, expect, it } from "vitest";
import {
  DEBOUNCE_MS,
  MAX_RESTARTS,
  MAX_STEERING_TIPS,
  MAX_TIPS,
  PAUSE_MS,
  RESTART_WINDOW_MS,
  inCommitWindow,
  isFiller,
  isNewTurn,
  isQuestion,
  mergeTips,
  recentRestarts,
  runDelayMs,
  tipCap,
  tipKey,
  waitsForRun,
} from "./steering";

describe("isFiller", () => {
  it("treats backchannel and fillers as filler", () => {
    for (const line of ["yeah", "Okay.", "um", "uh-huh", "Hmm, yeah", "mhm", "ok, sure", "Right, thanks!", "yep yep", "please", "cool", ""]) {
      expect(isFiller(line), line).toBe(true);
    }
  });

  it("treats a line with a content word as content", () => {
    for (const line of ["When does SSO ship?", "yeah, what about pricing", "Acme renewal", "okay so the discount"]) {
      expect(isFiller(line), line).toBe(false);
    }
  });
});

describe("tipKey", () => {
  it("trims, drops note cites and collapses spaces", () => {
    expect(tipKey("  SSO ships in Q4 [n1] ")).toBe("SSO ships in Q4");
    expect(tipKey("SSO  ships\nin Q4")).toBe("SSO ships in Q4");
    expect(tipKey("Node 22 is current [web]")).toBe("Node 22 is current");
  });
});

describe("mergeTips", () => {
  const A = "Offer 10% if they sign this week [n1]";
  const B = "Ask who owns the rollout plan";
  const C = "SSO ships in Q4 for enterprise [n2]";
  const D = "Check the backend salary band";

  it("is a no-op when the run returns the tips already shown", () => {
    expect(mergeTips([A, B], [A, B])).toEqual([A, B]);
  });

  it("matches by trimmed, cite-normalised text and keeps the shown text", () => {
    expect(mergeTips([A], ["  Offer 10% if they sign this week  "])).toEqual([A]);
    expect(mergeTips([A], ["Offer 10% if they sign this week [n3]"])).toEqual([A]);
  });

  it("appends new tips after kept ones", () => {
    expect(mergeTips([A], [A, C])).toEqual([A, C]);
  });

  it("replaces a kept tip the run left out (a correction)", () => {
    expect(mergeTips([A, B], [A, C])).toEqual([A, C]);
  });

  it("keeps the shown tips when the run has none (NONE or an error)", () => {
    expect(mergeTips([A, B], [])).toEqual([A, B]);
  });

  it("caps at 3 in a burst and at 2 without kept tips", () => {
    expect(MAX_TIPS).toBe(2);
    expect(MAX_STEERING_TIPS).toBe(3);
    expect(tipCap(0)).toBe(2);
    expect(tipCap(1)).toBe(3);
    expect(mergeTips([A, B], [A, B, C, D])).toEqual([A, B, C]);
    expect(mergeTips([], [A, B, C])).toEqual([A, B]);
  });

  it("drops duplicates inside the run's own tips", () => {
    expect(mergeTips([], [A, `${A} `, B])).toEqual([A, B]);
  });

  it("while streaming, keeps tips the run has not repeated yet", () => {
    expect(mergeTips([A, B], [C], undefined, false)).toEqual([A, B, C]);
    expect(mergeTips([A, B], [A], undefined, false)).toEqual([A, B]);
  });

  it("while streaming, drops unrepeated kept tips before new ones when the cap is full", () => {
    expect(mergeTips([A, B], [C, D], undefined, false)).toEqual([A, C, D]);
    expect(mergeTips([A, B, C], [D], undefined, false)).toEqual([A, B, D]);
  });
});

describe("run delay and restart cap", () => {
  it("starts the first line of a turn at once", () => {
    expect(runDelayMs([], 100_000, false)).toBe(0);
  });

  it("waits the debounce while steering and restarts are few", () => {
    expect(runDelayMs([], 100_000, true)).toBe(DEBOUNCE_MS);
    expect(runDelayMs([99_000, 98_000], 100_000, true)).toBe(DEBOUNCE_MS);
  });

  it("makes the 4th restart inside 10 s wait for a pause in speech", () => {
    const now = 100_000;
    const three = [now - 6000, now - 4000, now - 1000];
    expect(three).toHaveLength(MAX_RESTARTS);
    expect(runDelayMs(three, now, true)).toBe(PAUSE_MS);
    expect(PAUSE_MS).toBeGreaterThan(DEBOUNCE_MS);
  });

  it("forgets restarts older than the window", () => {
    const now = 100_000;
    const old = [now - RESTART_WINDOW_MS - 1, now - RESTART_WINDOW_MS - 500, now - 500];
    expect(recentRestarts(old, now)).toEqual([now - 500]);
    expect(runDelayMs(old, now, true)).toBe(DEBOUNCE_MS);
  });
});

describe("inCommitWindow", () => {
  it("is false until the run is on its second tip", () => {
    expect(inCommitWindow(0)).toBe(false);
    expect(inCommitWindow(1)).toBe(false);
    expect(inCommitWindow(2)).toBe(true);
    expect(inCommitWindow(3)).toBe(true);
  });
});

describe("waitsForRun", () => {
  const steer = { fresh: false, runTips: 0, answering: false, asked: false };

  it("cancels a run that has just started for a line that steers it", () => {
    expect(waitsForRun(steer)).toBe(false);
  });

  it("lets a run in its commit window finish", () => {
    expect(waitsForRun({ ...steer, runTips: 2 })).toBe(true);
  });

  it("lets a run answering a question finish when the room keeps talking, but not when a newer question comes", () => {
    expect(waitsForRun({ ...steer, answering: true })).toBe(true);
    expect(waitsForRun({ ...steer, answering: true, asked: true })).toBe(false);
  });

  it("never waits for a new turn", () => {
    expect(waitsForRun({ fresh: true, runTips: 2, answering: true, asked: false })).toBe(false);
  });
});

describe("isQuestion", () => {
  it("finds direct questions, with or without the question mark", () => {
    for (const line of ["why are there tube closures", "Why are there tube closures?", "So what's in the news in London", "how does SSO work", "Is there a strike today", "tell me the score", "the budget is approved?"]) {
      expect(isQuestion(line), line).toBe(true);
    }
  });

  it("does not treat statements as questions", () => {
    for (const line of ["Let's pick up the Acme renewal.", "There are tube closures today", "Will is joining later", "Do it now", "yeah"]) {
      expect(isQuestion(line), line).toBe(false);
    }
  });
});

describe("isNewTurn", () => {
  it("starts afresh for a new utterance after the last answer settled, however soon: no earlier answer is shown", () => {
    expect(isNewTurn({ open: true, busy: false, spokenDuringRun: false })).toBe(true);
  });

  it("steers the run when the line comes while Bee is still answering: earlier tips stay", () => {
    expect(isNewTurn({ open: true, busy: true, spokenDuringRun: false })).toBe(false);
  });

  it("counts an interruption whose speech-to-text finished after the answer settled", () => {
    expect(isNewTurn({ open: true, busy: false, spokenDuringRun: true })).toBe(false);
  });

  it("always starts afresh after a dismissal", () => {
    expect(isNewTurn({ open: false, busy: true, spokenDuringRun: true })).toBe(true);
    expect(isNewTurn({ open: false, busy: false, spokenDuringRun: false })).toBe(true);
  });
});
