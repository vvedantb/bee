import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { IrreversibleKind } from "./computer-control";
import type { ConfirmRequest } from "./computer-tools";
import { browseGateHook, runCostUsd, toolRouter } from "./claude-agent";
import { BROWSE_DECLINED, BROWSE_NO_CONFIRM } from "./browse-gate";

// The hook Claude Code runs before each browse execute (core/claude-agent.ts browseGateHook), called as Claude Code calls it.

const SEND = "await page.getByRole('button', { name: 'Send' }).click()";

function preToolUse(tool: string, code: string, id = "toolu_1"): HookInput {
  return { hook_event_name: "PreToolUse", session_id: "s", transcript_path: "/t", cwd: "/c", tool_name: tool, tool_input: { code }, tool_use_id: id };
}

async function runHook(input: HookInput, request: { confirm?: (request: ConfirmRequest, signal: AbortSignal) => Promise<boolean>; onConfirmed?: (id: string, kind: IrreversibleKind) => void } | null) {
  const hook = browseGateHook(() => (request ? { ...request, signal: new AbortController().signal } : null));
  const callback = hook.hooks[0];
  if (!callback) throw new Error("no hook");
  expect(hook.matcher).toBe("mcp__browse__execute");
  return callback(input, "toolu_1", { signal: new AbortController().signal });
}

describe("browseGateHook", () => {
  it("lets a harmless execute run as auto mode decides, without asking", async () => {
    let asked = 0;
    expect(await runHook(preToolUse("mcp__browse__execute", "await page.goto('https://example.com')"), { confirm: async () => (asked++, true) })).toEqual({});
    expect(asked).toBe(0);
  });

  it("asks the island's Confirm for a send, allows it on Confirm, and reports the call as confirmed", async () => {
    const asked: ConfirmRequest[] = [];
    const confirmed: [string, IrreversibleKind][] = [];
    const output = await runHook(preToolUse("mcp__browse__execute", SEND, "toolu_9"), {
      confirm: async (request) => {
        asked.push(request);
        return true;
      },
      onConfirmed: (id, kind) => confirmed.push([id, kind]),
    });
    expect(asked).toEqual([{ kind: "send", question: "Send this?", detail: "Click “Send” in your browser" }]);
    expect(output).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "The user confirmed it in Bee." } });
    expect(confirmed).toEqual([["toolu_9", "send"]]);
  });

  it("denies a declined send, and any risky execute when no one can be asked", async () => {
    const confirmed: string[] = [];
    expect(await runHook(preToolUse("mcp__browse__execute", SEND), { confirm: async () => false, onConfirmed: (id) => confirmed.push(id) })).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: BROWSE_DECLINED },
    });
    expect(await runHook(preToolUse("mcp__browse__execute", SEND), {})).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: BROWSE_NO_CONFIRM } });
    expect(await runHook(preToolUse("mcp__browse__execute", SEND), null)).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: BROWSE_NO_CONFIRM } });
    expect(confirmed).toEqual([]);
  });

  it("leaves other tools alone", async () => {
    expect(await runHook(preToolUse("mcp__browse__status", SEND), {})).toEqual({});
  });
});

describe("runCostUsd", () => {
  it("charges a fresh session's first run the whole total", () => {
    expect(runCostUsd(0.25, 0)).toEqual({ costUsd: 0.25, sessionCostUsd: 0.25, nextPrevious: 0.25 });
  });

  it("charges a later run the difference from the session total, and keeps the cumulative apart", () => {
    const second = runCostUsd(0.75, 0.25);
    expect(second.costUsd).toBeCloseTo(0.5);
    expect(second.sessionCostUsd).toBe(0.75);
    expect(second.nextPrevious).toBe(0.75);
  });

  it("calls a resumed session's first run unknown, then measures from its total", () => {
    const first = runCostUsd(3, null);
    expect(first).toEqual({ costUsd: null, sessionCostUsd: 3, nextPrevious: 3 });
    expect(runCostUsd(3.5, first.nextPrevious).costUsd).toBeCloseTo(0.5);
  });

  it("gives null and keeps the previous total when the result has no usable total", () => {
    expect(runCostUsd(undefined, 1)).toEqual({ costUsd: null, sessionCostUsd: null, nextPrevious: 1 });
    expect(runCostUsd(Number.NaN, null)).toEqual({ costUsd: null, sessionCostUsd: null, nextPrevious: null });
  });

  it("gives null when the total fell below the previous one", () => {
    expect(runCostUsd(1, 2).costUsd).toBeNull();
  });
});

describe("toolRouter", () => {
  it("lists every Bee tool with alwaysLoad, so Claude Code never defers them behind ToolSearch", async () => {
    const router = toolRouter();
    await router.use({ click: tool({ description: "Click", inputSchema: z.object({ ref: z.string(), effect: z.enum(["none", "send"]) }), execute: async () => "ok" }) }, new AbortController().signal);
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await router.server.connect(serverSide);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientSide);
    const { tools } = await client.listTools();
    expect(tools.map((item) => item.name)).toEqual(["click"]);
    expect(tools[0]?._meta).toEqual({ "anthropic/alwaysLoad": true });
    expect(tools[0]?.inputSchema.required).toContain("effect");
    await client.close();
  });
});
