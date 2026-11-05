import type { ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import {
  CACHE_BREAKPOINTS_MAX,
  COMPACT_AT_TOKENS,
  KEEP_RECENT_TOKENS,
  SUMMARY_INPUT_MAX_CHARS,
  CONVERSATION_IDLE_MS,
  SUMMARY_HEADER,
  addExchange,
  assistantMessage,
  cacheAtEnd,
  cacheBreakpoints,
  chunkLines,
  cleanForHistory,
  commandFallbackReply,
  compactMessages,
  compactSplit,
  compactingStep,
  estimateTokens,
  historyAsText,
  historySummariser,
  parseHistory,
  repairHistory,
  summaryText,
  userMessage,
  type BeeExchange,
} from "./bee-history";
import { COMMAND_CONTEXT_TOKENS, GUIDE_CONTEXT_TOKENS } from "./gateway";

const exchange = (index: number, patch: Partial<BeeExchange> = {}): BeeExchange => ({ request: `request ${index}`, reply: `reply ${index}`, at: index * 1000, ...patch });
const CACHE = { anthropic: { cacheControl: { type: "ephemeral" } } };

/** One request with a real tool call and result, then the AI's answer. */
const toolTurn = (index: number, result = `${index} users`): ModelMessage[] => [
  userMessage(`count users ${index}`),
  { role: "assistant", content: [{ type: "tool-call", toolCallId: `call_${index}`, toolName: "eva__count_table", input: { table: "users" } }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: `call_${index}`, toolName: "eva__count_table", output: { type: "text", value: result } }] },
  assistantMessage(`- Eva has ${result}.`),
];

describe("Bee's history: every turn, kept whole", () => {
  it("keeps tool calls and results, and drops thinking, cache markers, system messages and bytes", () => {
    const cleaned = cleanForHistory([
      { role: "system", content: "rules" },
      { role: "user", content: [{ type: "text", text: "count users", providerOptions: CACHE }, { type: "image", image: "aGVsbG8=" }] },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "plan", providerOptions: { anthropic: { signature: "sig" } } },
          { type: "tool-call", toolCallId: "c1", toolName: "eva__count_table", input: { table: "users" } },
        ],
      },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "eva__count_table", output: { type: "json", value: { count: 16 } } }] },
      assistantMessage("- Eva has 16 users."),
    ]);
    expect(cleaned).toEqual([
      { role: "user", content: [{ type: "text", text: "count users" }, { type: "text", text: "[image omitted]" }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "eva__count_table", input: { table: "users" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "eva__count_table", output: { type: "json", value: { count: 16 } } }] },
      assistantMessage("- Eva has 16 users."),
    ]);
  });

  it("takes keys and tokens out of text, tool inputs and results", () => {
    const cleaned = cleanForHistory([
      userMessage("use key sk-ant-abcdefghijklmnopqrstuvwxyz"),
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "fetch", input: { header: "Bearer abcdefghijklmnop" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "fetch", output: { type: "text", value: "token vck_abcdefghijklmnop" } }] },
    ]);
    const text = JSON.stringify(cleaned);
    expect(text).not.toMatch(/sk-ant-abcdef|abcdefghijklmnop/);
    expect(text).toContain("[redacted");
  });

  it("writes a provider-run web search as text, since it cannot be replayed without that tool", () => {
    const cleaned = cleanForHistory([
      userMessage("news"),
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "s1", toolName: "web_search", input: { query: "tube closures" }, providerExecuted: true },
          { type: "tool-result", toolCallId: "s1", toolName: "web_search", output: { type: "json", value: [{ title: "TfL", url: "https://tfl.gov.uk/status" }] } },
          { type: "text", text: "- The Circle line is closed." },
        ],
      },
    ]);
    expect(JSON.stringify(cleaned)).not.toContain("tool-call");
    expect(JSON.stringify(cleaned[1])).toContain("https://tfl.gov.uk/status");
  });

  it("keeps calls and results in pairs: a half on its own is dropped", () => {
    const repaired = repairHistory([
      { role: "tool", content: [{ type: "tool-result", toolCallId: "orphan", toolName: "x", output: { type: "text", value: "y" } }] },
      userMessage("go"),
      { role: "assistant", content: [{ type: "text", text: "Looking." }, { type: "tool-call", toolCallId: "cut", toolName: "snapshot", input: {} }] },
    ]);
    expect(repaired).toEqual([userMessage("go"), assistantMessage("Looking.")]);
  });

  it("has no idle expiry and no turn cap: a hundred turns, days apart, all stay", () => {
    let messages: ModelMessage[] = [];
    for (let index = 1; index <= 100; index++) messages = parseHistory([...messages, ...toolTurn(index)]);
    expect(messages).toHaveLength(400);
    expect(messages[0]).toEqual(userMessage("count users 1"));
    expect(estimateTokens(messages)).toBeLessThan(COMPACT_AT_TOKENS);
  });

  it("reads back what it wrote, and drops what the AI SDK would refuse", () => {
    const messages = [...toolTurn(1), ...toolTurn(2)];
    const file = JSON.parse(JSON.stringify({ version: 1, messages }));
    expect(parseHistory(file)).toEqual(messages);
    expect(parseHistory({ version: 1, messages: [{ role: "robot", content: "?" }, ...messages] })).toEqual(messages);
    expect(parseHistory("nonsense")).toEqual([]);
  });

  it("writes tool parts as text for a request with no tools", () => {
    const text = historyAsText(toolTurn(1));
    expect(JSON.stringify(text)).not.toContain("tool-call");
    expect(text.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(JSON.stringify(text)).toContain("1 users");
  });
});

describe("compaction near the window", () => {
  const big = (index: number) => toolTurn(index, `${index} users ${"x".repeat(4000)}`);

  it("leaves messages under the threshold alone (the same array)", async () => {
    const messages = toolTurn(1);
    let calls = 0;
    expect(await compactMessages(messages, { summarise: async () => `${calls++}` })).toBe(messages);
    expect(calls).toBe(0);
  });

  it("over the threshold, folds the oldest into one summary and keeps the newest word for word", async () => {
    const messages = Array.from({ length: 10 }, (_, index) => big(index + 1)).flat();
    const folded: ModelMessage[][] = [];
    const out = await compactMessages(messages, {
      maxTokens: 5000,
      keepTokens: 3000,
      summarise: async (older) => {
        folded.push([...older]);
        return "Eva had 1 to 7 users.";
      },
    });
    expect(folded).toHaveLength(1);
    expect(out.length).toBeLessThan(messages.length);
    expect(out[0]?.role).toBe("user");
    expect(JSON.stringify(out[0])).toContain(SUMMARY_HEADER);
    expect(JSON.stringify(out[0])).toContain("Eva had 1 to 7 users.");
    // The newest turn's call, result and answer are untouched, and every kept call still has its result.
    expect(out.slice(-3)).toEqual(big(10).slice(1));
    expect(repairHistory(out)).toEqual(out);
    expect(estimateTokens(out)).toBeLessThan(estimateTokens(messages));
  });

  it("falls back to a plain summary when the summary call fails", async () => {
    const messages = Array.from({ length: 6 }, (_, index) => big(index + 1)).flat();
    const out = await compactMessages(messages, {
      maxTokens: 3000,
      keepTokens: 1500,
      summarise: async () => {
        throw new Error("offline");
      },
    });
    expect(JSON.stringify(out[0])).toContain("count users 5");
    expect(summaryText(toolTurn(1))).toContain("eva__count_table returned");
  });

  it("never cuts between a call and its result, and repeats the request when it falls in the folded part", async () => {
    // One long computer-use run: the request, then many steps.
    const steps: ModelMessage[] = [userMessage("read my chat with Zuzanna")];
    for (let index = 0; index < 12; index++) {
      steps.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: `s${index}`, toolName: "snapshot", input: { app: "ms-teams.exe" } }] });
      steps.push({ role: "tool", content: [{ type: "tool-result", toolCallId: `s${index}`, toolName: "snapshot", output: { type: "text", value: "tree ".repeat(800) } }] });
    }
    const cut = compactSplit(steps, 2000);
    expect(cut).not.toBeNull();
    expect(steps[cut ?? 0]?.role).not.toBe("tool");
    const out = await compactMessages(steps, { maxTokens: 4000, keepTokens: 2000, summarise: async () => "Bee took snapshots of Teams." });
    expect(JSON.stringify(out[0])).toContain("read my chat with Zuzanna");
    expect(out[1]?.role).toBe("assistant");
    expect(repairHistory(out)).toEqual(out);
  });

  it("compacts at 400k of COMMAND_MODEL's 1M window, well before the limit, and keeps 150k word for word", () => {
    expect(COMMAND_CONTEXT_TOKENS).toBe(1_000_000);
    expect(COMPACT_AT_TOKENS).toBe(400_000);
    expect(KEEP_RECENT_TOKENS).toBe(150_000);
    expect(KEEP_RECENT_TOKENS).toBeLessThan(COMPACT_AT_TOKENS);
    expect(COMPACT_AT_TOKENS).toBeLessThan(COMMAND_CONTEXT_TOKENS);
    // One summary call fits GUIDE_MODEL's window (4 characters a token) with room for the system and the reply.
    expect(SUMMARY_INPUT_MAX_CHARS / 4).toBeLessThan(GUIDE_CONTEXT_TOKENS);
    expect(SUMMARY_INPUT_MAX_CHARS / 4).toBeGreaterThan(COMPACT_AT_TOKENS - KEEP_RECENT_TOKENS);
  });

  it("compacts in prepareStep only when needed", async () => {
    const step = compactingStep({ maxTokens: 3000, keepTokens: 1500, summarise: async () => "summary" });
    expect(await step({ messages: toolTurn(1) })).toBeUndefined();
    const result = await step({ messages: Array.from({ length: 6 }, (_, index) => big(index + 1)).flat() });
    expect(JSON.stringify(result?.messages[0])).toContain("summary");
  });
});

describe("the summary call", () => {
  const model = (prompts: string[]) =>
    new MockLanguageModelV4({
      doGenerate: async (options) => {
        prompts.push(JSON.stringify(options.prompt));
        return {
          content: [{ type: "text", text: `summary ${prompts.length}` }],
          finishReason: { unified: "stop", raw: undefined },
          usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
          warnings: [],
        };
      },
    });
  const turns = Array.from({ length: 6 }, (_, index) => toolTurn(index + 1, `${index + 1} users ${"x".repeat(1500)}`)).flat();

  it("reads input that fits in one call", async () => {
    const prompts: string[] = [];
    expect(await historySummariser(model(prompts))(turns)).toBe("summary 1");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("count users 1");
    expect(prompts[0]).not.toContain("Older lines left out");
  });

  it("summarises longer input in chunks, folding each into the summary so far, and drops nothing", async () => {
    const prompts: string[] = [];
    expect(await historySummariser(model(prompts), { maxInputChars: 2500, maxChunks: 50 })(turns)).toBe(`summary ${prompts.length}`);
    expect(prompts.length).toBeGreaterThan(1);
    expect(prompts[0]).toContain("count users 1");
    expect(prompts.at(-1)).toContain("Eva has 6 users");
    expect(prompts[1]).toContain("summary 1");
    expect(prompts.join("")).not.toContain("Older lines left out");
  });

  it("leaves out only the oldest chunks past the chunk limit, and says so", async () => {
    const prompts: string[] = [];
    await historySummariser(model(prompts), { maxInputChars: 2500, maxChunks: 2 })(turns);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("Older lines left out");
    expect(prompts.at(-1)).toContain("Eva has 6 users");
  });

  it("chunks lines within the limit, oldest first", () => {
    expect(chunkLines(["aaa", "bbb", "ccc"], 8)).toEqual(["aaa\nbbb", "ccc"]);
    expect(chunkLines(["x".repeat(20)], 8)[0]?.length).toBe(8);
  });
});

describe("the conversation for vmem", () => {
  it("keeps every exchange (no cap), clipping long fields and leaving out empty ones", () => {
    let list: BeeExchange[] = [];
    for (let index = 1; index <= 20; index++) list = addExchange(list, exchange(index));
    expect(list).toHaveLength(20);
    expect(CONVERSATION_IDLE_MS).toBe(10 * 60_000);
    const [kept] = addExchange([], { request: "  open\n Vercel  usage ", reply: "x".repeat(5000), actions: [], endedWhere: "", error: "", at: 1 });
    expect(kept?.request).toBe("open Vercel usage");
    expect(kept?.reply.length).toBe(2000);
    expect(kept).not.toHaveProperty("actions");
  });
});

describe("cache breakpoints", () => {
  it("puts one cache breakpoint on the end of the history, and counts breakpoints", () => {
    const messages = cacheAtEnd(toolTurn(1), CACHE);
    expect(messages.at(-1)).toEqual({ role: "assistant", content: [{ type: "text", text: "- Eva has 1 users.", providerOptions: CACHE }] });
    expect(cacheBreakpoints({ instructions: { providerOptions: CACHE }, messages })).toBe(2);
    expect(cacheAtEnd([], CACHE)).toEqual([]);
    expect(CACHE_BREAKPOINTS_MAX).toBe(4);
  });
});

describe("commandFallbackReply", () => {
  it("asks which one for a pointer, else says Bee is not sure", () => {
    expect(commandFallbackReply("open the team one")).toBe("Which one?");
    expect(commandFallbackReply("do the thing with the numbers")).toBe("Bee isn't sure what to do next.");
  });
});
