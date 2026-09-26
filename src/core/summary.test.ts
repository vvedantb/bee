import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { chunkNote } from "./notes";
import {
  SUMMARY_SYSTEM,
  buildLocalSummary,
  buildSummaryPrompt,
  generateMeetingSummary,
  parseSummaryMarkdown,
  summaryFileName,
} from "./summary";

const when = new Date(2026, 8, 26, 9, 5);
const transcript = ["Let's pick up the Acme renewal.", "Sam will send the quote by Friday."];
const notesCited = ["Acme renewal › Pricing"];

const MODEL_REPLY = [
  "```markdown",
  "# Summary",
  "## Decisions",
  "- Offer the 10% loyalty discount.",
  "## Action items",
  "- Sam: send the quote by Friday.",
  "## Topics",
  "- Acme renewal: discount and timing.",
  "```",
].join("\n");

function mockModel(text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 10, text: 10, reasoning: undefined },
      },
      warnings: [],
    },
  });
}

describe("summaryFileName", () => {
  it("uses local date and time", () => {
    expect(summaryFileName(when)).toBe("meeting-2026-09-26-0905.md");
  });
});

describe("buildSummaryPrompt", () => {
  it("lists the transcript and the notes shown", () => {
    const { system, prompt } = buildSummaryPrompt({ transcript: ["  First ", "Second"], notesCited });
    expect(system).toBe(SUMMARY_SYSTEM);
    expect(prompt).toContain("- First\n- Second");
    expect(prompt).toContain("Notes shown during the meeting:\n- Acme renewal › Pricing");
    expect(prompt.endsWith("Summary:")).toBe(true);
  });

  it("marks missing notes", () => {
    expect(buildSummaryPrompt({ transcript: ["Hi"] }).prompt).toContain("Notes shown during the meeting:\n- (none)");
  });
});

describe("parseSummaryMarkdown", () => {
  it("drops fences, titles and preamble", () => {
    const body = parseSummaryMarkdown(`Here you go:\n${MODEL_REPLY}`);
    expect(body?.startsWith("## Decisions")).toBe(true);
    expect(body).not.toContain("```");
    expect(body).not.toContain("# Summary");
    expect(body).toContain("- Sam: send the quote by Friday.");
  });

  it("rejects replies without the expected sections", () => {
    expect(parseSummaryMarkdown("I cannot help with that.")).toBeNull();
    expect(parseSummaryMarkdown("## Decisions\n- One")).toBeNull();
  });
});

describe("buildLocalSummary", () => {
  it("keeps every heading and the transcript under Topics", () => {
    const markdown = buildLocalSummary({ transcript, notesCited, tips: ["Offer 10% [n1]"], when });
    expect(markdown.startsWith("# Meeting summary — 2026-09-26 09:05\n")).toBe(true);
    for (const heading of ["## Decisions", "## Action items", "## Topics", "## Notes cited", "## Tips shown"]) {
      expect(markdown).toContain(heading);
    }
    expect(markdown).toContain("## Topics\n- Let's pick up the Acme renewal.\n- Sam will send the quote by Friday.");
    expect(markdown).toContain("## Notes cited\n- Acme renewal › Pricing");
  });

  it("omits tips when there were none and chunks into one snippet per section", () => {
    const markdown = buildLocalSummary({ transcript, when });
    expect(markdown).not.toContain("## Tips shown");
    const titles = chunkNote({ name: summaryFileName(when), content: markdown }).map((snippet) => snippet.title);
    expect(titles).toEqual([
      "Meeting summary — 2026-09-26 09:05 › Decisions",
      "Meeting summary — 2026-09-26 09:05 › Action items",
      "Meeting summary — 2026-09-26 09:05 › Topics",
      "Meeting summary — 2026-09-26 09:05 › Notes cited",
    ]);
  });
});

describe("generateMeetingSummary", () => {
  it("wraps the model's sections with the title and notes cited, without sampling parameters", async () => {
    const model = mockModel(MODEL_REPLY);
    const result = await generateMeetingSummary({ model, transcript, notesCited, when });
    expect(result).toMatchObject({ usedLlm: true, error: null });
    expect(result.markdown).toBe(
      [
        "# Meeting summary — 2026-09-26 09:05",
        "## Decisions\n- Offer the 10% loyalty discount.\n## Action items\n- Sam: send the quote by Friday.\n## Topics\n- Acme renewal: discount and timing.",
        "## Notes cited\n- Acme renewal › Pricing",
      ].join("\n\n") + "\n",
    );
    const call = model.doGenerateCalls[0];
    expect(call?.temperature).toBeUndefined();
    expect(call?.topP).toBeUndefined();
    expect(call?.providerOptions).toMatchObject({ gateway: { serviceTier: "flex" }, openai: { reasoningEffort: "low" } });
  });

  it("fails open to the local summary when the reply is unusable", async () => {
    const result = await generateMeetingSummary({ model: mockModel("NONE"), transcript, when });
    expect(result.usedLlm).toBe(false);
    expect(result.error).toMatch(/^Luna summary failed: /);
    expect(result.markdown).toBe(buildLocalSummary({ transcript, when }));
  });
});
