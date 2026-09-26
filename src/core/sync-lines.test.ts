import { describe, expect, it } from "vitest";
import {
  addClockSample,
  clockOffset,
  clockSample,
  mergeLines,
  phraseToLine,
  pipelineText,
  shouldShare,
  summaryTranscript,
  type SessionLine,
} from "./sync-lines";

function line(id: string, clientTs: number, own = true, speakerName = "Me"): SessionLine {
  return { id, own, speakerId: own ? "me" : speakerName.toLowerCase(), speakerName, text: `${id} text`, clientTs, serverTs: null };
}

describe("mergeLines", () => {
  it("orders by spoken time, keeps arrival order on ties, drops duplicates and keeps the newest max", () => {
    const local = [line("a", 1000), line("c", 3000)];
    const peers = [line("b", 2000, false, "Bob"), line("d", 3000, false, "Bob"), line("a", 1000)];
    expect(mergeLines(local, peers, 10).map((entry) => entry.id)).toEqual(["a", "b", "c", "d"]);
    expect(mergeLines(local, peers, 2).map((entry) => entry.id)).toEqual(["c", "d"]);
  });
});

describe("phraseToLine", () => {
  it("moves the relay's spoken time onto this device's clock", () => {
    const phrase = { seq: 4, roomId: "r1", speakerId: "user_bob", speakerName: "Bob", text: "Hi", spokenAt: 10_500, serverTs: 11_000 };
    expect(phraseToLine(phrase, 500)).toEqual({ id: "r1:4", own: false, speakerId: "user_bob", speakerName: "Bob", text: "Hi", clientTs: 10_000, serverTs: 11_000 });
  });
});

describe("labels", () => {
  it("labels teammates for the pipeline and everyone for the summary once synced", () => {
    const lines = [line("a", 1), line("b", 2, false, "Bob")];
    expect(lines.map(pipelineText)).toEqual(["a text", "Bob: b text"]);
    expect(summaryTranscript(lines, "Alice")).toEqual([
      { speaker: "Alice", text: "a text" },
      { speaker: "Bob", text: "b text" },
    ]);
  });

  it("keeps plain strings for a solo meeting", () => {
    expect(summaryTranscript([line("a", 1)], "Alice")).toEqual(["a text"]);
  });
});

describe("clock offset", () => {
  it("uses the sample with the shortest round trip", () => {
    let samples = addClockSample([], clockSample(0, 400, 10_300));
    samples = addClockSample(samples, clockSample(1000, 1020, 11_010));
    expect(clockOffset(samples)).toBe(10_000);
    expect(clockOffset([])).toBe(0);
  });
});

describe("shouldShare", () => {
  it("shares only mic phrases, only in a sync, never while paused", () => {
    expect(shouldShare({ inRoom: true, shareMuted: false, source: "mic" })).toBe(true);
    expect(shouldShare({ inRoom: true, shareMuted: true, source: "mic" })).toBe(false);
    expect(shouldShare({ inRoom: false, shareMuted: false, source: "mic" })).toBe(false);
    expect(shouldShare({ inRoom: true, shareMuted: false, source: "typed" })).toBe(false);
  });
});
