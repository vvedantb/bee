import { generateText, isStepCount, streamText, type LanguageModel, type ModelMessage } from "ai";
import { promptParts, type AgentRequest, type AgentTier, type CommandAgent } from "../../src/core/claude-agent";
import { stopOnNoProgress } from "../../src/core/loop-guard";

// Tests only: a CommandAgent (core/claude-agent.ts) on an AI SDK mock model, so the "Bee, …" paths run with no Claude Code process.
// It sends what the real agent sends: Bee's system prompt, then one user message with the earlier turns as text and the request's
// parts. The AI SDK runs the tool loop, with the same loop guard and turn limit the real agent applies. `requests` records each call.
// It streams (doStream) when the request listens for events, as answers do, and generates (doGenerate) otherwise, as computer use
// does; `stream` forces one. Generated runs report events per step, each step's text in one delta.

export type ModelAgent = CommandAgent & { requests: AgentRequest[] };

export function modelAgent(model: LanguageModel | ((tier: AgentTier) => LanguageModel), options: { stream?: boolean } = {}): ModelAgent {
  const requests: AgentRequest[] = [];
  const agent = async (request: AgentRequest) => {
    requests.push(request);
    let looped = false;
    const call = {
      model: typeof model === "function" ? model(request.tier) : model,
      instructions: { role: "system" as const, content: request.system },
      messages: [{ role: "user" as const, content: promptParts(request.history, request.content).map((text) => ({ type: "text" as const, text })) }],
      tools: request.tools,
      stopWhen: [stopOnNoProgress(() => (looped = true)), ...(request.maxTurns !== undefined ? [isStepCount(request.maxTurns)] : [])],
      abortSignal: request.signal,
      maxRetries: 0,
    };
    if (!(options.stream ?? Boolean(request.onEvent))) {
      const result = await generateText({
        ...call,
        onStepEnd: (step) => {
          request.onEvent?.({ type: "step-start" });
          for (const toolCall of step.toolCalls) request.onEvent?.({ type: "tool-start", id: toolCall.toolCallId, tool: toolCall.toolName });
          for (const toolCall of step.toolCalls) request.onEvent?.({ type: "tool-end", id: toolCall.toolCallId, tool: toolCall.toolName });
          if (step.text) request.onEvent?.({ type: "text-delta", text: step.text });
        },
      });
      const messages: ModelMessage[] = [...result.responseMessages];
      return { text: result.text, messages, finish: result.finishReason === "tool-calls" ? ("tool-calls" as const) : ("stop" as const), looped, sources: [], costUsd: null };
    }
    const result = streamText({ ...call, onError: () => undefined });
    let text = "";
    for await (const part of result.stream) {
      if (part.type === "start-step") {
        text = "";
        request.onEvent?.({ type: "step-start" });
      } else if (part.type === "tool-call") request.onEvent?.({ type: "tool-start", id: part.toolCallId, tool: part.toolName });
      else if ((part.type === "tool-result" && !part.preliminary) || part.type === "tool-error") request.onEvent?.({ type: "tool-end", id: part.toolCallId, tool: part.toolName });
      else if (part.type === "text-delta") {
        text += part.text;
        request.onEvent?.({ type: "text-delta", text: part.text });
      } else if (part.type === "error") throw part.error;
      else if (part.type === "abort") throw request.signal.reason instanceof Error ? request.signal.reason : new Error("aborted");
    }
    if (request.signal.aborted) throw request.signal.reason instanceof Error ? request.signal.reason : new Error("aborted");
    const finishReason = await result.finishReason;
    const messages: ModelMessage[] = [...(await result.responseMessages)];
    return { text, messages, finish: finishReason === "tool-calls" ? ("tool-calls" as const) : ("stop" as const), looped, sources: [], costUsd: null };
  };
  return Object.assign(agent, { requests });
}
