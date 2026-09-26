import { describe, expect, it } from "vitest";
import { SEED_NOTES, chunkNotes } from "./notes";
import { runPipeline } from "./pipeline";

describe("runPipeline", () => {
  it("still retrieves notes locally when no Gateway key is set", async () => {
    const result = await runPipeline({
      transcript: ["When does SSO ship?"],
      snippets: chunkNotes(SEED_NOTES),
      gateway: null,
    });
    expect(result.notes[0]?.title).toBe("Q4 product roadmap › Dates");
    expect(result.notes.every((note) => note.jevScore === null && note.cite === null)).toBe(true);
    expect(result.rankSource).toBe("fallback");
    expect(result.guideError).toContain("No AI Gateway key");
    expect(result.tips).toEqual([]);
  });
});
