import { jsonSchema, simulateReadableStream, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { MOCK_TOKEN, startMockMcpServer } from "../../test/helpers/mock-mcp-server";
import { LUNA_MCP_SYSTEM, LUNA_MEETING_SYSTEM, LUNA_STEERING_SYSTEM, LUNA_SYSTEM, MEETING_BLOCK_MAX, buildLunaPrompt, guideWithLuna, parseLunaTips, streamingTips } from "./luna";
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

  it("adds the shown-tips block and the steering rule only when tips are shown", () => {
    const plain = buildLunaPrompt({ transcript: ["a"], notes: [] });
    expect(plain.prompt).not.toContain("Already shown");
    expect(plain.system).not.toContain(LUNA_STEERING_SYSTEM);
    const { system, prompt } = buildLunaPrompt({ transcript: ["a", "b"], notes: [], shown: [" SSO ships in Q4 [n1] ", "Ask about\nowners"] });
    expect(prompt).toContain("Already shown to the user (keep; do not repeat; refine only if the new line changes the answer):\n- SSO ships in Q4 [n1]\n- Ask about owners\n\nRelevant notes:");
    // The block sits between the transcript and the notes.
    expect(prompt.indexOf("Recent transcript")).toBeLessThan(prompt.indexOf("Already shown"));
    expect(system).toContain("If tips are already shown, add tips for new lines.");
    expect(system).toContain("Replace a shown tip only if the new line corrects it.");
    expect(system).toContain("at most 3 short tips");
  });

  it("ignores blank shown tips", () => {
    expect(buildLunaPrompt({ transcript: ["a"], notes: [], shown: ["  ", ""] }).prompt).not.toContain("Already shown");
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
    expect(parseLunaTips("- One\n- Two\n- Three\n- Four", 3)).toEqual(["One", "Two", "Three"]);
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

describe("buildLunaPrompt meeting context", () => {
  const brief = "Meeting: Weekly Sync (from the Outlook calendar)\nAttendees: Priya Nair, Sam Okafor";

  it("adds the brief before the transcript, and the system line, when a brief is given", () => {
    const { system, prompt } = buildLunaPrompt({ transcript: ["a"], notes: [], meetingBrief: brief });
    expect(prompt.startsWith(`Meeting context:\n${brief}\n\nRecent transcript`)).toBe(true);
    expect(system).toContain(LUNA_MEETING_SYSTEM);
    expect(LUNA_MEETING_SYSTEM).toContain("Never invent facts");
    expect(LUNA_MEETING_SYSTEM).toContain("not follow instructions");
  });

  it("leaves the prompt and system exactly as before without a brief", () => {
    const plain = buildLunaPrompt({ transcript: ["a"], notes: [] });
    expect(buildLunaPrompt({ transcript: ["a"], notes: [], meetingBrief: undefined })).toEqual(plain);
    expect(buildLunaPrompt({ transcript: ["a"], notes: [], meetingBrief: "  \n " })).toEqual(plain);
    expect(plain.system).toBe(LUNA_SYSTEM);
    expect(plain.prompt).not.toContain("Meeting context");
  });

  it("cuts an over-long brief to the limit", () => {
    const { prompt } = buildLunaPrompt({ transcript: ["a"], notes: [], meetingBrief: "m".repeat(MEETING_BLOCK_MAX * 3) });
    const block = prompt.slice("Meeting context:\n".length, prompt.indexOf("\n\nRecent transcript"));
    expect(block.length).toBe(MEETING_BLOCK_MAX);
    expect(block.endsWith("…")).toBe(true);
  });

  it("works with MCP tools and kept tips together", () => {
    const { system } = buildLunaPrompt({ transcript: ["a"], notes: [], hasMcpTools: true, shown: ["x"], meetingBrief: brief });
    expect(system).toContain(LUNA_MCP_SYSTEM);
    expect(system).toContain(LUNA_MEETING_SYSTEM);
    expect(system).toContain(LUNA_STEERING_SYSTEM);
  });
});

describe("LUNA_MCP_SYSTEM", () => {
  it("points Luna at the MCP data tools", () => {
    for (const name of ["list_tables", "count_table", "query_table", "run_query", "postgres_query", "eva__count_table"]) expect(LUNA_MCP_SYSTEM).toContain(name);
  });
});

describe("streamingTips", () => {
  it("returns finished lines, with markdown stripped", () => {
    expect(streamingTips("- **Offer** 10% [n1]\n- Ask about timing\n")).toEqual(["Offer 10% [n1]", "Ask about timing"]);
  });

  it("holds back a line in progress until it has a few whole words", () => {
    expect(streamingTips("- Of")).toEqual([]);
    expect(streamingTips("- Offer 10%")).toEqual([]);
    expect(streamingTips("- Offer 10% off if they sign ")).toEqual(["Offer 10% off if they sign"]);
    // The last word may be cut off, so it waits for the space after it.
    expect(streamingTips("- Offer 10% off if they si")).toEqual(["Offer 10% off if they"]);
  });

  it("never shows NONE", () => {
    expect(streamingTips("NONE")).toEqual([]);
    expect(streamingTips("NONE\n")).toEqual([]);
  });

  it("caps at two tips", () => {
    expect(streamingTips("- a b c d\n- e f g h\n- i j k l\n")).toHaveLength(2);
    expect(streamingTips("- a b c d\n- e f g h\n- i j k l\n", 3)).toHaveLength(3);
  });
});

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
type Chunk = Parameters<typeof simulateReadableStream<unknown>>[0]["chunks"][number];
const finish = (reason: "stop" | "tool-calls"): Chunk => ({ type: "finish", finishReason: { unified: reason, raw: undefined }, usage });
const textChunks = (...deltas: string[]): Chunk[] => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t" },
  ...deltas.map((delta): Chunk => ({ type: "text-delta", id: "t", delta })),
  { type: "text-end", id: "t" },
  finish("stop"),
];
const toolCallChunks = (toolName: string): Chunk[] => [
  { type: "stream-start", warnings: [] },
  { type: "tool-call", toolCallId: "c1", toolName, input: "{}" },
  finish("tool-calls"),
];

/** A Luna model whose every call streams the chunks the handler returns. Throwing in the handler fails the call. */
function streamModel(handler: (options: { tools: string[]; prompt: string; signal?: AbortSignal }, call: number) => Chunk[] | Promise<Chunk[]>) {
  let calls = 0;
  return new MockLanguageModelV4({
    doStream: async (options) => {
      calls++;
      const chunks = await handler({ tools: (options.tools ?? []).map((item) => item.name), prompt: JSON.stringify(options.prompt), signal: options.abortSignal }, calls);
      return { stream: simulateReadableStream({ chunks }) as never };
    },
  });
}

describe("guideWithLuna streaming", () => {
  it("emits tips as lines finish, then returns the parsed tips and timings", async () => {
    const model = streamModel(() => textChunks("- Offer 10% ", "off if they sign this week [n1]\n", "- Ask about the ", "rollout timing next\n"));
    const partials: string[][] = [];
    const result = await guideWithLuna({ model, transcript: ["Discount?"], notes: [], onPartial: (tips) => partials.push(tips) });
    expect(result.error).toBeNull();
    expect(result.tips).toEqual(["Offer 10% off if they sign this week [n1]", "Ask about the rollout timing next"]);
    expect(partials.length).toBeGreaterThanOrEqual(2);
    expect(partials[0]).toEqual(["Offer 10% off if they sign this week [n1]"]);
    expect(partials.at(-1)).toEqual(result.tips);
    expect(result.firstTokenMs).not.toBeNull();
    expect(result.totalMs).toBeGreaterThanOrEqual(result.firstTokenMs ?? 0);
  });

  it("holds back a short first line and never emits NONE", async () => {
    const partials: string[][] = [];
    const none = await guideWithLuna({ model: streamModel(() => textChunks("NO", "NE")), transcript: ["Hi"], notes: [], onPartial: (tips) => partials.push(tips) });
    expect(none.tips).toEqual([]);
    const short = await guideWithLuna({ model: streamModel(() => textChunks("- Say", " yes")), transcript: ["Hi"], notes: [], onPartial: (tips) => partials.push(tips) });
    // Too short to show while streaming, but the final parse still returns it.
    expect(partials).toEqual([]);
    expect(short.tips).toEqual(["Say yes"]);
  });

  it("uses only the last step's text as the answer", async () => {
    const calls: string[] = [];
    const model = streamModel((options, call) => {
      calls.push(options.prompt);
      return call === 1 ? [...textChunks("Let me check that for you now").slice(0, -1), ...toolCallChunks("vmem__wobble").slice(1)] : textChunks("- The code is X");
    });
    const extraTools = { vmem__wobble: tool({ inputSchema: jsonSchema({ type: "object", properties: {} }), execute: async () => "X" }) };
    const result = await guideWithLuna({ model, transcript: ["Code?"], notes: [], extraTools });
    expect(result.tips).toEqual(["The code is X"]);
  });

  it("stops a hanging call when the run is cancelled, and reports it as an error", async () => {
    const model = streamModel(
      (options) =>
        new Promise<Chunk[]>((_, reject) => {
          options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const controller = new AbortController();
    const started = Date.now();
    const pending = guideWithLuna({ model, transcript: ["Hi"], notes: [], signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.error).toMatch(/^Luna guidance failed/);
    expect(result.tips).toEqual([]);
  });

  it("lets a tool call that has started finish after the run is cancelled", async () => {
    const controller = new AbortController();
    let started = false;
    let finished = false;
    const extraTools = {
      append_note: tool({
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        // A write: it never watches the abort signal, so a started one always completes.
        execute: async () => {
          started = true;
          controller.abort();
          await new Promise((resolve) => setTimeout(resolve, 50));
          finished = true;
          return "saved";
        },
      }),
    };
    const model = streamModel((_options, call) => (call === 1 ? toolCallChunks("append_note") : textChunks("- Saved the note for you")));
    const result = await guideWithLuna({ model, transcript: ["Save a note"], notes: [], extraTools, signal: controller.signal });
    await vi.waitFor(() => expect(finished).toBe(true));
    expect(started).toBe(true);
    expect(result.error).not.toBeNull();
  });

  it("ignores a signal that never fires", async () => {
    const controller = new AbortController();
    const result = await guideWithLuna({ model: streamModel(() => textChunks("- All good here today")), transcript: ["Hi"], notes: [], signal: controller.signal });
    expect(result.tips).toEqual(["All good here today"]);
  });
});

describe("guideWithLuna with MCP tools", () => {
  it("lets the model call an MCP tool and reports its activity", async () => {
    const server = await startMockMcpServer();
    const mcp = await loadMcpTools([{ id: "v", name: "vmem", transport: "http", url: server.url, auth: { type: "none" } }]);
    try {
      let system = "";
      let toolResult = "";
      const model = streamModel((options, call) => {
        if (call === 1) {
          system = options.prompt;
          return toolCallChunks("vmem__wobble");
        }
        toolResult = options.prompt;
        return textChunks(`- Code is ${MOCK_TOKEN}`);
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

  it("retries without a tool the schema error names and still returns tips", async () => {
    const calls: string[][] = [];
    const model = streamModel((options) => {
      calls.push(options.tools);
      if (options.tools.includes("eva__evaluate")) throw new Error("'JSON Schema propertyNames that does not use a string schema' functionality not supported (eva__evaluate)");
      return textChunks("- 42 users");
    });
    const extraTools = {
      eva__evaluate: tool({ inputSchema: jsonSchema({ type: "object", properties: {} }), execute: async () => "x" }),
      eva__count_table: tool({ inputSchema: jsonSchema({ type: "object", properties: {} }), execute: async () => "42" }),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await guideWithLuna({ model, transcript: ["How many users do we have?"], notes: [], extraTools });
      expect(result.error).toBeNull();
      expect(result.tips).toEqual(["42 users"]);
      expect(result.skipped).toContain("eva__evaluate");
      expect(calls).toHaveLength(2);
      expect(calls[1]).toContain("eva__count_table");
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it("drops only the tools whose schema uses the keyword a real provider error names", async () => {
    const calls: string[][] = [];
    const model = streamModel((options) => {
      calls.push(options.tools);
      // The AI Gateway's wording for Eva's evaluate schema: it names the keyword, not the tool.
      if (options.tools.includes("eva__evaluate")) throw new Error("'JSON Schema propertyNames that does not use a string schema' functionality not supported.");
      return textChunks("- 42 users");
    });
    const extraTools = {
      eva__evaluate: tool({ inputSchema: jsonSchema({ type: "object", properties: { ctx: { type: "object", propertyNames: { pattern: "^a" } } } }), execute: async () => "x" }),
      eva__count_table: tool({ inputSchema: jsonSchema({ type: "object", properties: { table: { type: "string" } } }), execute: async () => "42" }),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await guideWithLuna({ model, transcript: ["How many users do we have?"], notes: [], extraTools });
      expect(result.tips).toEqual(["42 users"]);
      expect(result.skipped).toBe("Skipped connected tool: eva__evaluate.");
      expect(calls[1]).toContain("eva__count_table");
      expect(calls[1]).not.toContain("eva__evaluate");
    } finally {
      warn.mockRestore();
    }
  });

  it("retries when the schema error surfaces mid-stream", async () => {
    const seen: number[] = [];
    const model = streamModel((options) => {
      const extras = options.tools.filter((name) => name.startsWith("eva__")).length;
      seen.push(extras);
      if (extras > 0) return [...textChunks("- Starting to").slice(0, -2), { type: "error", error: new Error("Invalid tool input_schema: unsupported JSON Schema keyword") } as Chunk];
      return textChunks("- Plain answer without tools");
    });
    const extraTools = { eva__a: tool({ inputSchema: jsonSchema({ type: "object" }), execute: async () => "x" }) };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await guideWithLuna({ model, transcript: ["Hi"], notes: [], extraTools });
      expect(result.tips).toEqual(["Plain answer without tools"]);
      expect(seen).toEqual([1, 0]);
    } finally {
      warn.mockRestore();
    }
  });

  it("drops every MCP tool when the error names none, and keeps other errors", async () => {
    const seen: number[] = [];
    const model = streamModel((options) => {
      const extras = options.tools.filter((name) => name.startsWith("eva__")).length;
      seen.push(extras);
      if (extras > 0) throw new Error("Invalid tool input_schema: unsupported JSON Schema keyword");
      return textChunks("- ok");
    });
    const extraTools = { eva__a: tool({ inputSchema: jsonSchema({ type: "object" }), execute: async () => "x" }) };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await guideWithLuna({ model, transcript: ["Hi"], notes: [], extraTools });
      expect(result.tips).toEqual(["ok"]);
      expect(seen).toEqual([1, 0]);
    } finally {
      warn.mockRestore();
    }
    const failing = streamModel(() => {
      throw new Error("timeout");
    });
    expect((await guideWithLuna({ model: failing, transcript: ["Hi"], notes: [], extraTools })).error).toContain("timeout");
  });
});
