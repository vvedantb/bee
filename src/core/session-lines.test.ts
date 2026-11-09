import { describe, expect, it } from "vitest";
import {
  mergeLines,
  pipelineText,
  summaryTranscript,
  type SessionLine,
} from "./session-lines";

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

describe("labels", () => {
  it("labels teammates for the pipeline and everyone for the summary once anyone else spoke", () => {
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
