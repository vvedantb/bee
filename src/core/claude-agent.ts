import { randomUUID } from "node:crypto";
import { query, type Options, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { asSchema, type AssistantModelMessage, type ModelMessage, type ToolSet } from "ai";
import { historyAsText } from "./bee-history";
import { debugLog, msSince } from "./debug-log";
import { CLAUDE_CODE_SIGNED_OUT } from "./claude-code";
import { noProgress } from "./loop-guard";

// Bee's "Bee, …" requests (direct answers in luna.ts, computer use in computer-use.ts) run on the Claude Agent SDK, on the user's own
// Claude Code install and its login (main/claude-code.ts finds it and checks it). Bee ships no Claude Code and keeps no token.
// Meeting tips, summaries, speech-to-text and Jev stay on the AI Gateway (gateway.ts): they are latency-bound, and the SDK starts a
// Claude Code process per run.
//
// Bee's own tools (computer, desktop, memory, files, MCP connectors) go to the SDK as one in-process MCP server, "bee". Their own
// checks (confirm before a send or delete, the blocked-app list, the run's Stop and clock) live inside each tool's execute, so they
// apply here unchanged. Claude Code's own tools are all off, except WebSearch when the request asks for web_search. No settings
// files, CLAUDE.md, skills or session files are read or written: the run is only Bee's system prompt, its request and its tools.

/** A request's model. "plan" thinks first (adaptive, medium effort); "fast" is the fast pass for a simple task, thinking off. */
export type AgentTier = "plan" | "fast";

export const AGENT_MODEL: Record<AgentTier, string> = { plan: "claude-sonnet-5-5", fast: "claude-haiku-5-5" };

/** What happens during a run, in order. Tool names are Bee's own (open_app, web_search), never the SDK's mcp__bee__… names. */
export type AgentEvent =
  | { type: "step-start" }
  | { type: "text-delta"; text: string }
  | { type: "tool-start"; id: string; tool: string }
  | { type: "tool-end"; id: string; tool: string };

export type AgentRequest = {
  tier: AgentTier;
  system: string;
  /** Earlier turns with Bee (core/bee-history.ts), oldest first. They go as text before the request: the SDK takes no assistant turns. */
  history: readonly ModelMessage[];
  /** The request's own text parts, in order. */
  content: readonly string[];
  /** Bee's tools. A tool without execute (the Gateway's provider-run web_search) turns on the SDK's own WebSearch instead. */
  tools: ToolSet;
  /** Model turns at most. None: the run ends when the AI stops, on the signal, or on the loop guard. */
  maxTurns?: number;
  signal: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
};

export type AgentFinish = "stop" | "tool-calls" | "error";

export type AgentResult = {
  /** The last model turn's text: the answer. */
  text: string;
  /** What the AI said and did, as AI SDK messages for Bee's history. */
  messages: ModelMessage[];
  /** "tool-calls": the turns ran out while it was still calling tools. */
  finish: AgentFinish;
  /** The loop guard stopped it: the same call kept giving the same result (core/loop-guard.ts). */
  looped: boolean;
  /** Web pages the SDK's WebSearch returned, as { url, title }, for tools.ts sourcesFromGenerateResult. */
  sources: { url: string; title: string }[];
  costUsd: number | null;
};

/** Runs one request. Throws on a failed or aborted run. Tests pass their own (test/helpers/agent.ts). */
export type CommandAgent = (request: AgentRequest) => Promise<AgentResult>;

const SERVER = "bee";
const PREFIX = `mcp__${SERVER}__`;
const WEB_SEARCH = "web_search";
const SDK_WEB_SEARCH = "WebSearch";
const RESULT_CHARS = 40_000;

/** Bee's name for an SDK tool name. */
export function beeToolName(name: string): string {
  if (name === SDK_WEB_SEARCH) return WEB_SEARCH;
  return name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name;
}

/** A tool's result as the text the model reads. */
function resultText(output: unknown): string {
  const text = typeof output === "string" ? output : JSON.stringify(output) ?? "";
  return text.length > RESULT_CHARS ? `${text.slice(0, RESULT_CHARS - 1)}…` : text;
}

/** Bee's tools with an execute, as one in-process MCP server. Input is checked against each tool's own schema first. */
async function beeServer(tools: ToolSet, signal: AbortSignal) {
  const local = Object.entries(tools).flatMap(([name, item]) => (item.execute ? [{ name, item, execute: item.execute, schema: asSchema(item.inputSchema) }] : []));
  const listed = await Promise.all(local.map(async ({ name, item, schema }) => ({ name, description: item.description ?? name, inputSchema: { type: "object" as const, ...(await schema.jsonSchema) } })));
  const server = new McpServer({ name: SERVER, version: "1.0.0" }, { capabilities: { tools: {} } });
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listed }));
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const found = local.find((entry) => entry.name === request.params.name);
    if (!found) return { content: [{ type: "text", text: `Error: unknown tool ${request.params.name}` }], isError: true };
    const input = request.params.arguments ?? {};
    const checked = found.schema.validate ? await found.schema.validate(input) : { success: true as const, value: input };
    if (!checked.success) return { content: [{ type: "text", text: `Error: bad input: ${checked.error.message}` }], isError: true };
    try {
      const output = await found.execute(checked.value, { toolCallId: randomUUID(), messages: [], abortSignal: signal, context: {} });
      return { content: [{ type: "text", text: resultText(output) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  });
  return { server, names: local.map(({ name }) => `${PREFIX}${name}`) };
}

/** Messages as one plain transcript, tool calls and results written as text (bee-history.ts historyAsText). */
export function transcriptText(messages: readonly ModelMessage[]): string {
  return historyAsText(messages)
    .map((message) => {
      const text = typeof message.content === "string" ? message.content : message.content.map((part) => ("text" in part && typeof part.text === "string" ? part.text : "")).join("\n");
      const who = message.role === "assistant" ? "Bee" : message.role === "user" ? "User" : message.role === "tool" ? "Tool" : "System";
      return text.trim() ? `${who}: ${text.trim()}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

const EARLIER = "Earlier turns with Bee, oldest first (Bee's tool calls and results are written as text; they were confirmed when they ran):";

/** The request's first and only user message: the earlier turns as text, then the request's parts. */
export function promptParts(history: readonly ModelMessage[], content: readonly string[]): string[] {
  const earlier = history.length > 0 ? transcriptText(history) : "";
  return [...(earlier ? [`${EARLIER}\n${earlier}`] : []), ...content];
}

async function* single(parts: readonly string[]): AsyncGenerator<SDKUserMessage> {
  yield { type: "user", message: { role: "user", content: parts.map((text) => ({ type: "text", text })) }, parent_tool_use_id: null };
}

/** URL and title pairs in a WebSearch result's text. */
function searchSources(text: string): { url: string; title: string }[] {
  const found: { url: string; title: string }[] = [];
  for (const match of text.matchAll(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"url"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) found.push({ title: match[1] ?? "", url: match[2] ?? "" });
  return found.filter((source) => /^https?:\/\//.test(source.url));
}

/** A tool result block's text. */
function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "")).join("\n");
}

/** Env for the Claude Code process: Bee's own, so the install finds its login (config folder, keychain, or an env token) as it would. */
function agentEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  return { ...env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
}

/** A failure that means the install is not signed in, as Claude Code words it. */
const SIGNED_OUT = /not logged in|please run \/login|invalid api key|oauth token (?:has )?expired|authentication/i;

/** The production agent, on the user's Claude Code at `executable` (main/claude-code.ts). */
export function claudeAgent(options: { executable: string }): CommandAgent {
  return async (request) => {
    const started = performance.now();
    const controller = new AbortController();
    const abort = () => controller.abort(request.signal.reason);
    if (request.signal.aborted) abort();
    else request.signal.addEventListener("abort", abort, { once: true });
    const web = Object.entries(request.tools).some(([name, item]) => name === WEB_SEARCH && !item.execute);
    const { server, names } = await beeServer(request.tools, controller.signal);
    const sdkOptions: Options = {
      model: AGENT_MODEL[request.tier],
      systemPrompt: request.system,
      tools: web ? [SDK_WEB_SEARCH] : [],
      allowedTools: [...names, ...(web ? [SDK_WEB_SEARCH] : [])],
      permissionMode: "dontAsk",
      mcpServers: { [SERVER]: { type: "sdk", name: SERVER, instance: server } },
      thinking: request.tier === "plan" ? { type: "adaptive" } : { type: "disabled" },
      ...(request.tier === "plan" ? { effort: "medium" as const } : {}),
      ...(request.maxTurns !== undefined ? { maxTurns: request.maxTurns } : {}),
      includePartialMessages: true,
      settingSources: [],
      persistSession: false,
      abortController: controller,
      env: agentEnv(),
      pathToClaudeCodeExecutable: options.executable,
      stderr: (data) => debugLog.debug("ai", "agent-stderr", { data: data.slice(0, 2000) }),
    };
    // Bee's history, merged by the API message id (the SDK sends one block per assistant message).
    const messages: ModelMessage[] = [];
    const toolNames = new Map<string, string>();
    const steps: { toolCalls: { toolCallId: string; toolName: string; input?: unknown }[]; toolResults: { toolCallId: string; output?: unknown }[] }[] = [];
    const sources: { url: string; title: string }[] = [];
    let lastId = "";
    let turnText = "";
    let looped = false;
    let finish: AgentFinish = "stop";
    let costUsd: number | null = null;
    let failure: string | null = null;
    try {
      for await (const message of query({ prompt: single(promptParts(request.history, request.content)), options: sdkOptions })) {
        handle(message);
        if (looped) break;
      }
    } finally {
      request.signal.removeEventListener("abort", abort);
    }
    function handle(message: SDKMessage): void {
      if (message.type === "stream_event") {
        const event = message.event;
        if (event.type === "message_start") {
          turnText = "";
          request.onEvent?.({ type: "step-start" });
        } else if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
          request.onEvent?.({ type: "tool-start", id: event.content_block.id, tool: beeToolName(event.content_block.name) });
        } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          turnText += event.delta.text;
          request.onEvent?.({ type: "text-delta", text: event.delta.text });
        }
      } else if (message.type === "assistant") {
        if (message.parent_tool_use_id) return;
        const parts = message.message.content.flatMap((block): Exclude<AssistantModelMessage["content"], string> => {
          if (block.type === "text") return [{ type: "text", text: block.text }];
          if (block.type !== "tool_use") return [];
          const tool = beeToolName(block.name);
          toolNames.set(block.id, tool);
          return [{ type: "tool-call", toolCallId: block.id, toolName: tool, input: block.input }];
        });
        const calls = message.message.content.flatMap((block) => (block.type === "tool_use" ? [{ toolCallId: block.id, toolName: beeToolName(block.name), input: block.input }] : []));
        if (calls.length > 0) steps.push({ toolCalls: calls, toolResults: [] });
        const last = messages.at(-1);
        if (message.message.id === lastId && last?.role === "assistant" && typeof last.content !== "string") last.content.push(...parts);
        else if (parts.length > 0) messages.push({ role: "assistant", content: parts });
        lastId = message.message.id;
      } else if (message.type === "user") {
        if (message.parent_tool_use_id || typeof message.message.content === "string") return;
        const results = message.message.content.flatMap((block) => (block.type === "tool_result" ? [{ id: block.tool_use_id, text: blockText(block.content) }] : []));
        if (results.length === 0) return;
        for (const result of results) {
          const tool = toolNames.get(result.id) ?? "tool";
          request.onEvent?.({ type: "tool-end", id: result.id, tool });
          if (tool === WEB_SEARCH) sources.push(...searchSources(result.text));
          steps.at(-1)?.toolResults.push({ toolCallId: result.id, output: result.text });
        }
        messages.push({
          role: "tool",
          content: results.map((result) => ({ type: "tool-result", toolCallId: result.id, toolName: toolNames.get(result.id) ?? "tool", output: { type: "text", value: result.text } })),
        });
        lastId = "";
        if (noProgress(steps)) {
          looped = true;
          debugLog.warn("ai", "agent-no-progress", { steps: steps.length });
          controller.abort(new Error("loop"));
        }
      } else if (message.type === "result") {
        costUsd = message.total_cost_usd;
        if (message.subtype === "error_max_turns") finish = "tool-calls";
        else if (message.subtype !== "success" || message.is_error) {
          finish = "error";
          failure = message.subtype === "success" ? message.result : message.errors.join("; ") || message.subtype;
        }
      }
    }
    debugLog.info("ai", "agent-done", { tier: request.tier, ms: msSince(started), finish, looped, costUsd, tools: steps.length });
    if (request.signal.aborted) throw request.signal.reason instanceof Error ? request.signal.reason : new Error("aborted");
    if (failure !== null && !looped) throw new Error(SIGNED_OUT.test(failure) ? CLAUDE_CODE_SIGNED_OUT : failure);
    return { text: turnText.trim() ? turnText : lastText(messages), messages, finish, looped, sources, costUsd };
  };
}

/** The last assistant message's text, when no stream deltas came (a run that ended on the loop guard). */
function lastText(messages: readonly ModelMessage[]): string {
  const last = messages.findLast((message) => message.role === "assistant");
  if (!last || typeof last.content === "string") return typeof last?.content === "string" ? last.content : "";
  return last.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}
