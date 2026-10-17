import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { MOCK_TOKEN, startMockMcpServer } from "../../test/helpers/mock-mcp-server";
import { LUNA_MCP_SYSTEM, LUNA_SYSTEM, buildLunaPrompt, guideWithLuna, parseLunaTips } from "./luna";
import { loadMcpTools } from "./mcp";

describe("buildLunaPrompt", () => {
  it("includes the recent transcript and numbered notes", () => {
    const { system, prompt } = buildLunaPrompt({
      transcript: ["  First line ", "Second line"],
      notes: [
        { id: "x.md#1", title: "Acme › Pricing", text: "10% discount" },
        { id: "y.md#0", title: "Habits", text: "Summarise decisions" },
      ],
    });
    expect(system).toBe(LUNA_SYSTEM);
    expect(prompt).toContain("- First line\n- Second line");
    expect(prompt).toContain("[n1] Acme › Pricing\n10% discount");
    expect(prompt).toContain("[n2] Habits\nSummarise decisions");
    expect(prompt.endsWith("Tips:")).toBe(true);
  });

  it("adds the MCP guidance only when MCP tools are present", () => {
    expect(buildLunaPrompt({ transcript: ["a"], notes: [], hasMcpTools: false }).system).toBe(LUNA_SYSTEM);
    const { system } = buildLunaPrompt({ transcript: ["a"], notes: [], hasMcpTools: true });
    expect(system).toBe(`${LUNA_SYSTEM}\n${LUNA_MCP_SYSTEM}`);
    expect(system).toMatch(/Never invent a result/);
  });

  it("keeps only the last 8 transcript lines and marks missing notes", () => {
    const transcript = Array.from({ length: 12 }, (_, index) => `line ${index}`);
    const { prompt } = buildLunaPrompt({ transcript, notes: [] });
    expect(prompt).not.toContain("line 3");
    expect(prompt).toContain("line 4");
    expect(prompt).toContain("line 11");
    expect(prompt).toContain("Relevant notes:\n(none)");
  });
});

describe("LUNA_SYSTEM", () => {
  it("lets tips answer direct questions from notes or general knowledge", () => {
    expect(LUNA_SYSTEM).toContain("direct question");
    expect(LUNA_SYSTEM).toContain("general knowledge");
    expect(LUNA_SYSTEM).toContain("at most 2 short tips");
  });

  it("asks for plain text without markdown or links", () => {
    expect(LUNA_SYSTEM).toContain("plain text only");
    expect(LUNA_SYSTEM).toContain("Do not write links");
  });

  it("tells Luna when to search the web and when not to", () => {
    expect(LUNA_SYSTEM).toContain("web_search");
    expect(LUNA_SYSTEM).toContain("current events");
    expect(LUNA_SYSTEM).toContain("Do not search for stable general knowledge");
  });

  it("points Luna at the file tools, notes first, and keeps private facts off the web", () => {
    for (const name of ["list_dir", "search_files", "read_file", "append_note"]) expect(LUNA_SYSTEM).toContain(name);
    expect(LUNA_SYSTEM).toContain("Prefer the notes above");
    expect(LUNA_SYSTEM).toContain("Do not use web_search for private facts");
    expect(LUNA_SYSTEM).toContain("clearly asks to add or save a note");
  });
});

describe("parseLunaTips", () => {
  it("strips bullets and numbering and caps at two tips", () => {
    expect(parseLunaTips("- Offer 10% [n1]\n* Ask about timing\n3. Third")).toEqual(["Offer 10% [n1]", "Ask about timing"]);
  });

  it("treats NONE and blank output as no tips", () => {
    expect(parseLunaTips("NONE")).toEqual([]);
    expect(parseLunaTips("  \n ")).toEqual([]);
  });

  it("strips bold, italic, backticks and headings", () => {
    expect(parseLunaTips("- **bold** and __also__ and *it* and _it2_")).toEqual(["bold and also and it and it2"]);
    expect(parseLunaTips("## Summary\n- Use `read_file` [n1]")).toEqual(["Summary", "Use read_file [n1]"]);
  });

  it("drops markdown links and citations but keeps the label and note cites", () => {
    expect(parseLunaTips("- Node 22 is current ([nodejs.org](https://nodejs.org/en?utm_source=openai))")).toEqual(["Node 22 is current nodejs.org"]);
    expect(parseLunaTips("- See [the docs](https://a.com/x) [n2]")).toEqual(["See the docs [n2]"]);
  });
});

describe("guideWithLuna with MCP tools", () => {
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  };

  it("lets the model call an MCP tool and reports its activity", async () => {
    const server = await startMockMcpServer();
    const mcp = await loadMcpTools([{ id: "v", name: "vmem", transport: "http", url: server.url, auth: { type: "none" } }]);
    try {
      let calls = 0;
      let system = "";
      let toolResult = "";
      const model = new MockLanguageModelV4({
        doGenerate: async (options) => {
          calls++;
          system = JSON.stringify(options.prompt[0]);
          if (calls === 1) {
            return {
              content: [{ type: "tool-call", toolCallId: "c1", toolName: "vmem__wobble", input: "{}" }],
              finishReason: { unified: "tool-calls", raw: undefined },
              usage,
              warnings: [],
            };
          }
          toolResult = JSON.stringify(options.prompt);
          return { content: [{ type: "text", text: `- Code is ${MOCK_TOKEN}` }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
        },
      });
      const activity: string[] = [];
      const result = await guideWithLuna({ model, transcript: ["What is the WOBBLE code?"], notes: [], extraTools: mcp.tools, onActivity: (tool) => activity.push(tool) });
      expect(result.error).toBeNull();
      expect(result.tips).toEqual([`Code is ${MOCK_TOKEN}`]);
      expect(toolResult).toContain(MOCK_TOKEN);
      expect(system).toContain("MCP servers");
      expect(activity.filter((name) => name === "vmem__wobble")).toHaveLength(1);
    } finally {
      await mcp.close();
      await server.close();
    }
  });
});
